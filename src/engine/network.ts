import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

/** Only these literal loopback hosts are locally authorized by default. */
function localHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export class NetworkPolicyError extends Error {
  constructor(message = "Endpoint denied by the test-target network policy.") {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

/** Public unicast IPs only; loopback authorization is handled separately. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    const c = octets[2] ?? -1;
    return !(
      a <= 0 ||
      a >= 224 ||
      a === 10 ||
      a === 127 ||
      (a === 168 && b === 63 && c === 129 && octets[3] === 16) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    return (
      /^[23][0-9a-f]{3}:/i.test(normalized) &&
      !/^2001:db8:/i.test(normalized) &&
      !(
        normalized.startsWith("2001:") &&
        Number.parseInt(normalized.split(":")[1] || "0", 16) < 0x200
      ) &&
      !/^2001::/i.test(normalized) &&
      !/^2002:/i.test(normalized) &&
      !/^3fff:/i.test(normalized)
    );
  }
  return false;
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetworkPolicyError("Endpoint must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new NetworkPolicyError(
      "Endpoint must use HTTP(S) without credentials, query parameters or fragments.",
    );
  }
  if (
    value.includes("\\") ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    throw new NetworkPolicyError();
  const host = hostname(url);
  if (host.endsWith(".") || host.includes("%") || host === "metadata.google.internal")
    throw new NetworkPolicyError();
  if (isIP(host) && !localHost(host) && !isPublicAddress(host)) throw new NetworkPolicyError();
  return url;
}

export function validateOrigin(value: string): void {
  const url = parseUrl(value);
  if (url.origin !== value)
    throw new NetworkPolicyError(
      "Allowlist entries must be exact HTTP(S) origins without a trailing slash or path.",
    );
}

export function validateEndpoint(value: string, allowedOrigins: string[]): URL {
  const url = parseUrl(value);
  if (!localHost(hostname(url)) && !allowedOrigins.includes(url.origin)) {
    throw new NetworkPolicyError("Remote test endpoints require an exact allowedOrigins entry.");
  }
  return url;
}

function pinnedLookup(isLocal: boolean): LookupFunction {
  return (host, options, callback) => {
    lookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(new Error("DNS lookup failed."), "");
        return;
      }
      const valid =
        addresses.length > 0 &&
        addresses.every((item) =>
          isLocal
            ? item.address === "127.0.0.1" || item.address === "::1"
            : isPublicAddress(item.address),
        );
      if (!valid) {
        callback(new NetworkPolicyError("Resolved endpoint address is denied."), "");
        return;
      }
      const first = addresses[0];
      if (!first) {
        callback(new Error("DNS returned no address."), "");
        return;
      }
      if (options.all) callback(null, [first]);
      else callback(null, first.address, first.family);
    });
  };
}

export interface HttpResult {
  status: number;
  body: Buffer;
}
export class RequestFailure extends Error {
  constructor(
    readonly kind: "timeout" | "network-error" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

/** Connection DNS is checked and pinned; redirects are returned and never followed. */
export function request(
  endpoint: string,
  allowedOrigins: string[],
  options: {
    method: "GET" | "POST";
    body?: Buffer;
    headers?: Record<string, string>;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<HttpResult> {
  const url = validateEndpoint(endpoint, allowedOrigins);
  if (options.body && options.body.length > 65_536)
    throw new NetworkPolicyError("Request body exceeds 64 KiB.");
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new RequestFailure("cancelled", "Request cancelled."));
      return;
    }
    let settled = false;
    let timedOut = false;
    const complete = (error?: Error, result?: HttpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: options.method,
        headers: options.headers,
        agent: false,
        lookup: pinnedLookup(localHost(hostname(url))),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65_536) {
            complete(new RequestFailure("network-error", "Response exceeds the 64 KiB bound."));
            response.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          complete(new RequestFailure("network-error", "Response read failed.")),
        );
        response.on("end", () =>
          complete(undefined, { status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    const abort = () => {
      complete(new RequestFailure("cancelled", "Request cancelled."));
      req.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      complete(new RequestFailure("timeout", "Request timed out."));
      req.destroy();
    }, options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    req.on("error", () =>
      complete(
        new RequestFailure(
          timedOut ? "timeout" : "network-error",
          timedOut ? "Request timed out." : "Request failed or target was denied.",
        ),
      ),
    );
    req.end(options.body);
  });
}
