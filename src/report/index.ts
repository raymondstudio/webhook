import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssertionResult,
  BusinessState,
  Outcome,
  RunReport,
  ScenarioConfig,
} from "../contracts.js";

const outcomeLabels: Record<Outcome, string> = {
  passed: "Assertions passed",
  failed: "Business outcome failed",
  error: "Execution error",
  cancelled: "Run cancelled",
};

function text(value: unknown, fallback = "Unknown"): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Endpoint queries, fragments and credentials never belong in a report. */
function endpoint(value: unknown): string {
  try {
    const url = new URL(text(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid endpoint]";
  }
}

function state(value: BusinessState | undefined): BusinessState {
  return {
    status: text(value?.status),
    fulfilmentCount: number(value?.fulfilmentCount, -1),
  };
}

function assertion(value: AssertionResult): AssertionResult {
  const outcome = ["passed", "failed", "error", "timed-out", "cancelled"].includes(value.outcome)
    ? value.outcome
    : "error";
  return {
    name: text(value.name),
    outcome,
    expected: state(value.expected),
    ...(value.actual ? { actual: state(value.actual) } : {}),
    observations: number(value.observations),
    message: text(value.message, "No assertion evidence recorded."),
  };
}

/** Whitelist public fields: never spread target data or serialize environment variables. */
export function serializeReport(report: RunReport): RunReport {
  const config = report.config;
  const assertions = (Array.isArray(report.assertions) ? report.assertions : []).map(assertion);
  const attempts = (Array.isArray(report.attempts) ? report.attempts : []).map((attempt) => ({
    eventId: text(attempt.eventId),
    deliveryIndex: number(attempt.deliveryIndex),
    attempt: number(attempt.attempt),
    plannedAtMs: number(attempt.plannedAtMs),
    startedAt: text(attempt.startedAt),
    durationMs: number(attempt.durationMs),
    status: attempt.status === null ? null : number(attempt.status),
    outcome: attempt.outcome,
  }));
  const errors = (Array.isArray(report.errors) ? report.errors : []).map((error) => text(error));
  let outcome: Outcome = Object.hasOwn(outcomeLabels, report.outcome) ? report.outcome : "error";
  const expectedAssertions = Array.isArray(config?.assertions) ? config.assertions : [];
  const plannedDeliveries = config?.deliveries ?? [];
  const hasDeliveryCoverage =
    plannedDeliveries.length > 0 &&
    plannedDeliveries.every((delivery, index) => {
      const matching = attempts.filter((attempt) => attempt.deliveryIndex === index);
      const last = matching.reduce<(typeof attempts)[number] | undefined>(
        (latest, attempt) => (!latest || attempt.attempt > latest.attempt ? attempt : latest),
        undefined,
      );
      return (
        matching.length > 0 &&
        matching.every((attempt) => attempt.eventId === delivery.eventId) &&
        last?.outcome === "http-success" &&
        last.status !== null &&
        last.status >= 200 &&
        last.status < 300
      );
    });
  const expectedNames = expectedAssertions.map((item) => item.name);
  const actualNames = assertions.map((item) => item.name);
  const hasAssertionCoverage =
    expectedNames.length > 0 &&
    new Set(expectedNames).size === expectedNames.length &&
    new Set(actualNames).size === actualNames.length &&
    expectedNames.length === actualNames.length &&
    expectedNames.every((name) => actualNames.includes(name));
  const hasMatchingPassedEvidence = assertions.every((item) => {
    if (item.outcome !== "passed") return true;
    const configured = expectedAssertions.find((expected) => expected.name === item.name);
    return (
      configured &&
      item.actual &&
      item.actual.status === configured.expected.status &&
      item.actual.fulfilmentCount === configured.expected.fulfilmentCount &&
      item.expected.status === configured.expected.status &&
      item.expected.fulfilmentCount === configured.expected.fulfilmentCount
    );
  });
  const incomplete =
    !hasDeliveryCoverage ||
    !hasAssertionCoverage ||
    !hasMatchingPassedEvidence ||
    !text(report.finishedAt, "") ||
    assertions.some((result) => result.observations < 1);
  if (incomplete) {
    const message =
      "Incomplete evidence: all configured assertions and delivery attempts are required.";
    if (!errors.includes(message)) errors.push(message);
    if (outcome !== "cancelled") outcome = "error";
  }
  if (
    outcome === "passed" &&
    (errors.length || assertions.some((item) => item.outcome !== "passed"))
  ) {
    const message = "A passing run requires every assertion to pass without execution errors.";
    if (!errors.includes(message)) errors.push(message);
    outcome = "error";
  }
  const publicConfig: Omit<ScenarioConfig, "signingSecretEnv"> = {
    version: 1,
    name: text(config?.name),
    seed: text(config?.seed),
    target: endpoint(config?.target),
    allowedOrigins: (config?.allowedOrigins ?? []).map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return "[invalid origin]";
      }
    }),
    events: (config?.events ?? []).map((event) => ({
      id: text(event.id),
      type: event.type,
      orderId: text(event.orderId),
      amount: number(event.amount),
      currency: text(event.currency),
    })),
    deliveries: (config?.deliveries ?? []).map((delivery) => ({
      eventId: text(delivery.eventId),
      atMs: number(delivery.atMs),
      ...(delivery.fault ? { fault: delivery.fault } : {}),
    })),
    assertions: expectedAssertions.map((item) => ({
      name: text(item.name),
      url: endpoint(item.url),
      expected: state(item.expected),
      settleMs: number(item.settleMs),
    })),
    concurrency: number(config?.concurrency),
    requestTimeoutMs: number(config?.requestTimeoutMs),
    deadlineMs: number(config?.deadlineMs),
    retry: {
      maxAttempts: number(config?.retry?.maxAttempts),
      delayMs: number(config?.retry?.delayMs),
    },
  };
  return {
    schemaVersion: 1,
    toolVersion: text(report.toolVersion),
    runId: text(report.runId),
    name: text(report.name),
    seed: text(report.seed),
    startedAt: text(report.startedAt),
    finishedAt: text(report.finishedAt, ""),
    outcome,
    environment: {
      node: text(report.environment?.node),
      platform: text(report.environment?.platform),
    },
    config: publicConfig,
    attempts,
    assertions,
    errors,
    limitations: (Array.isArray(report.limitations) ? report.limitations : []).map((item) =>
      text(item),
    ),
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stateText(value: BusinessState | undefined): string {
  return value
    ? `${value.status} · ${value.fulfilmentCount} fulfilment(s)`
    : "No business state received";
}

function badge(value: string, label: string = value): string {
  const tone = value === "passed" || value === "http-success" ? "good" : "warn";
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function duration(startedAt: string, finishedAt: string): string {
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0
    ? `${(elapsed / 1000).toFixed(2)} s`
    : "Incomplete";
}

export function renderHtml(input: RunReport): string {
  const report = serializeReport(input);
  const successful = report.attempts.filter((attempt) => attempt.outcome === "http-success").length;
  const passed = report.assertions.filter((item) => item.outcome === "passed").length;
  const assertionCards = report.assertions
    .map(
      (item, index) => `<article class="assertion" aria-labelledby="assertion-${index}">
        <div class="assertion-heading"><h3 id="assertion-${index}">${escapeHtml(item.name)}</h3>${badge(item.outcome)}</div>
        <div class="states"><div><span class="eyebrow">Expected</span><p>${escapeHtml(stateText(item.expected))}</p></div><div><span class="eyebrow">Observed</span><p>${escapeHtml(stateText(item.actual))}</p></div></div>
        <p class="evidence">${escapeHtml(item.message)}</p><p class="muted">${escapeHtml(item.observations)} observation(s)</p>
      </article>`,
    )
    .join("");
  const attempts = report.attempts
    .map(
      (attempt) =>
        `<tr><th scope="row"><span class="event-id">${escapeHtml(attempt.eventId)}</span><small>Delivery ${escapeHtml(attempt.deliveryIndex + 1)} · attempt ${escapeHtml(attempt.attempt)}</small></th><td><span class="mobile-label">Planned offset</span>+${escapeHtml(attempt.plannedAtMs)} ms</td><td><span class="mobile-label">Observed start</span><time>${escapeHtml(attempt.startedAt)}</time></td><td><span class="mobile-label">HTTP result</span>${badge(attempt.outcome, attempt.status === null ? attempt.outcome : `${attempt.status} · ${attempt.outcome}`)}</td><td><span class="mobile-label">Duration</span>${escapeHtml(attempt.durationMs.toFixed(1))} ms</td></tr>`,
    )
    .join("");
  const issues = report.errors.length
    ? `<aside class="issues" aria-labelledby="issues-title"><h2 id="issues-title">Execution evidence</h2><ul>${report.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></aside>`
    : "";
  const events = report.config.events
    .map(
      (event) =>
        `<li><code>${escapeHtml(event.id)}</code><span>${escapeHtml(event.type)} · order ${escapeHtml(event.orderId)} · ${escapeHtml(event.amount)} ${escapeHtml(event.currency)} (minor units)</span></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(report.name)} — Webhook Failure Lab</title>
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172334;background:#f3f5f8;line-height:1.5;--ink:#172334;--muted:#526176;--line:#dbe2eb;--green:#16603f;--amber:#853b12}*{box-sizing:border-box}body{margin:0}a{color:#17499b;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #b45309;outline-offset:5px;border-radius:3px}.skip-link{position:absolute;left:16px;top:-70px;background:white;padding:12px;z-index:10}.skip-link:focus{top:12px}.masthead{background:#13253e;color:#fff;border-bottom:4px solid #d18b44}.brandbar{max-width:1200px;margin:auto;padding:22px 32px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{display:flex;align-items:center;gap:12px;font-weight:720;letter-spacing:-.02em}.mark{display:grid;place-items:center;width:32px;height:32px;border:1px solid #8191a8;border-radius:8px;font-size:20px;color:#f3c58f}.edition{color:#c2d0e3;font-size:12px;text-transform:uppercase;letter-spacing:.12em}.container{max-width:1200px;margin:auto;padding:36px 32px 64px}.breadcrumb{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0 0 14px}h1{font-size:clamp(27px,4vw,40px);letter-spacing:-.035em;line-height:1.15;max-width:900px;overflow-wrap:anywhere;margin:0 0 12px}h2{font-size:21px;letter-spacing:-.025em;margin:0}h3{font-size:16px;letter-spacing:-.01em;margin:0;overflow-wrap:anywhere}p{margin:8px 0}.lede{color:var(--muted);max-width:790px;margin-bottom:24px}.run-summary{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 3px 12px #17233405}.outcome{padding:22px 24px;background:#edf7f1;border-left:5px solid #23754f}.outcome.warn{background:#fff5eb;border-left-color:#ad581f}.outcome .eyebrow{color:inherit}.outcome strong{display:block;font-size:24px;letter-spacing:-.025em}.outcome p{max-width:780px;font-size:14px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.metric{padding:20px 24px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric strong{display:block;font-size:25px;letter-spacing:-.025em}.metric span,.eyebrow{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.085em;font-weight:650}.metric small{font-size:12px;color:var(--muted)}.nav{display:flex;flex-wrap:wrap;gap:20px;border-bottom:1px solid var(--line);margin:26px 0 30px;padding-bottom:12px}.nav a{font-size:13px;font-weight:650}section{scroll-margin-top:20px;margin:32px 0}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:6px}.muted{color:var(--muted);font-size:13px}.section-note{color:var(--muted);font-size:14px;margin-bottom:18px}.assertion-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.assertion{background:#fff;border:1px solid var(--line);border-radius:9px;padding:20px}.assertion-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px}.badge{display:inline-block;padding:3px 8px;font-size:11px;font-weight:700;border-radius:5px;white-space:normal;overflow-wrap:anywhere;border:1px solid}.good{background:#e8f5ed;color:var(--green);border-color:#badbc8}.warn{background:#fff1e5;color:var(--amber);border-color:#edc6a7}.states{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.states p{font-size:13px;font-weight:620;overflow-wrap:anywhere}.evidence{border-top:1px solid var(--line);padding-top:14px;font-size:13px;overflow-wrap:anywhere}.issues{padding:20px 24px;background:#fff5eb;border:1px solid #edc6a7;border-radius:9px;margin:24px 0}.issues h2{font-size:16px}.issues ul{margin:8px 0 0;padding-left:20px;font-size:13px;overflow-wrap:anywhere}.table-wrap{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:white}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px;table-layout:fixed}thead{background:#eaf0f6}th,td{padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}thead th{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#43516a;font-weight:700}thead th:first-child{width:25%}thead th:nth-child(2){width:14%}thead th:nth-child(3){width:25%}thead th:nth-child(4){width:24%}tbody tr:last-child>*{border-bottom:0}.event-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:650}th small{display:block;font-family:inherit;font-weight:400;font-size:11px;color:var(--muted);margin-top:4px}.mobile-label{display:none}.empty{padding:24px;border:1px dashed #b77946;background:#fff7ef;border-radius:9px;color:#743910}.details-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.panel{background:#fff;border:1px solid var(--line);border-radius:9px;padding:20px;min-width:0}.metadata{margin:12px 0 0}.metadata div{padding:9px 0;border-bottom:1px solid #e9edf3}.metadata div:last-child{border:0}.metadata dt{font-size:11px;color:var(--muted)}.metadata dd{margin:2px 0 0;font-size:13px;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}summary{cursor:pointer;font-size:14px;font-weight:650;padding:5px 0}details{margin-top:16px}.event-list{list-style:none;padding:0;margin:12px 0 0;font-size:12px}.event-list li{border-top:1px solid var(--line);padding:10px 0;overflow-wrap:anywhere}.event-list span{display:block;color:var(--muted);margin-top:3px}.limits{font-size:13px;color:#43516a;padding-left:18px}.limits li{margin:9px 0;overflow-wrap:anywhere}.footer{font-size:12px;color:var(--muted);margin-top:32px;border-top:1px solid var(--line);padding-top:20px;display:flex;justify-content:space-between;gap:20px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}time{overflow-wrap:anywhere}
@media(max-width:760px){.brandbar{padding:18px 20px}.edition{font-size:10px}.container{padding:26px 20px 40px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{padding:16px 20px;border-bottom:1px solid var(--line)}.metric:nth-child(2){border-right:0}.metric:nth-child(n+3){border-bottom:0}.metric:last-child{border-bottom:0}.metric strong{font-size:22px}.assertion-grid,.details-grid{grid-template-columns:1fr}.outcome{padding:18px}.outcome strong{font-size:21px}.nav{gap:18px}.assertion-heading{flex-wrap:wrap}.table-wrap{border:0;background:none;overflow:visible}table,tbody,tr,th,td{display:block;width:100%}thead{display:none}tbody tr{margin:0 0 12px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px 16px}tbody th,tbody td{padding:7px 0;border:0;font-size:12px}tbody td{display:grid;grid-template-columns:104px minmax(0,1fr);gap:8px;align-items:start}.mobile-label{display:block;color:var(--muted);font-size:11px}.badge{justify-self:start}.footer{display:block}.footer span{display:block;margin:5px 0}.section-heading{display:block}.states{gap:12px}}
@media print{body{background:#fff}.masthead{background:#fff;color:var(--ink)}.nav,.skip-link{display:none}.container{padding:20px}.assertion,.panel,.run-summary{break-inside:avoid}.brandbar{padding:12px 20px}.edition{color:var(--muted)}}
</style></head><body>
<a class="skip-link" href="#main">Skip to report</a><header class="masthead"><div class="brandbar"><div class="brand"><span class="mark" aria-hidden="true">↪</span>Webhook Failure Lab</div><span class="edition">Local test report</span></div></header>
<main class="container" id="main"><p class="breadcrumb">Run evidence / v${escapeHtml(report.toolVersion)}</p><h1>${escapeHtml(report.name)}</h1><p class="lede">Test how a disposable application handles synthetic payment notifications. Delivery acknowledgements and business results are measured separately.</p>
<div class="run-summary"><div class="outcome ${report.outcome === "passed" ? "" : "warn"}"><span class="eyebrow">Final outcome</span><strong>${escapeHtml(outcomeLabels[report.outcome])}</strong><p>${report.outcome === "passed" ? "Every configured business assertion passed within this run’s observation window. This verifies the declared scenario, not universal payment correctness." : "This run does not establish the expected business outcome. Inspect the assertion evidence and delivery history below."}</p></div><div class="metrics"><div class="metric"><span>Business assertions</span><strong>${passed} / ${report.assertions.length}</strong><small>passed checks</small></div><div class="metric"><span>Delivery attempts</span><strong>${report.attempts.length}</strong><small>${successful} HTTP successes</small></div><div class="metric"><span>Elapsed</span><strong>${escapeHtml(duration(report.startedAt, report.finishedAt))}</strong><small>observed wall time</small></div><div class="metric"><span>Planned concurrency</span><strong>${escapeHtml(report.config.concurrency)}</strong><small>bounded requests</small></div></div></div>
<nav class="nav" aria-label="Report sections"><a href="#business">Business outcomes</a><a href="#delivery">Delivery timeline</a><a href="#configuration">Run details</a></nav>
${issues}<section id="business" aria-labelledby="business-title"><div class="section-heading"><h2 id="business-title">Business outcomes</h2><span class="muted">Read-only application assertions</span></div><p class="section-note">A successful HTTP response does not prove an order was fulfilled correctly.</p>${assertionCards ? `<div class="assertion-grid">${assertionCards}</div>` : '<div class="empty" role="status">No assertions executed. This report cannot establish business correctness.</div>'}</section>
<section id="delivery" aria-labelledby="delivery-title"><div class="section-heading"><h2 id="delivery-title">Delivery timeline</h2><span class="muted">${report.attempts.length} recorded attempt(s)</span></div><p class="section-note">Planned offsets come from the scenario. Observed starts reflect actual scheduling and network timing; concurrent order is not deterministic.</p>${attempts ? `<div class="table-wrap"><table><caption class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Observed delivery attempts with planned offset, HTTP result and elapsed request time</caption><thead><tr><th scope="col">Event / attempt</th><th scope="col">Planned offset</th><th scope="col">Observed start</th><th scope="col">HTTP result</th><th scope="col">Duration</th></tr></thead><tbody>${attempts}</tbody></table></div>` : '<div class="empty">No delivery attempts recorded. The run may be incomplete or stopped before delivery.</div>'}</section>
<section id="configuration" aria-labelledby="configuration-title"><h2 id="configuration-title">Run details &amp; boundaries</h2><p class="section-note">A self-contained snapshot: there is no live loading or background refresh. Re-run the CLI to collect new evidence.</p><div class="details-grid"><div class="panel"><h3>Reproducible plan</h3><dl class="metadata"><div><dt>Run ID</dt><dd>${escapeHtml(report.runId)}</dd></div><div><dt>Seed</dt><dd>${escapeHtml(report.seed)}</dd></div><div><dt>Target</dt><dd>${escapeHtml(report.config.target)}</dd></div><div><dt>Started</dt><dd>${escapeHtml(report.startedAt)}</dd></div><div><dt>Finished</dt><dd>${escapeHtml(report.finishedAt || "Incomplete")}</dd></div><div><dt>Runtime</dt><dd>Node ${escapeHtml(report.environment.node)} · ${escapeHtml(report.environment.platform)}</dd></div><div><dt>Bounds</dt><dd>${escapeHtml(report.config.deadlineMs)} ms run · ${escapeHtml(report.config.requestTimeoutMs)} ms request · ${escapeHtml(report.config.retry.maxAttempts)} attempt(s) per delivery</dd></div></dl><details><summary>Synthetic event identities (${report.config.events.length})</summary><ul class="event-list">${events || "<li>No configured events</li>"}</ul></details></div><div class="panel"><h3>What this report establishes</h3><ul class="limits"><li>Only the declared scenarios, assertions and observation windows were tested.</li><li>Synthetic notifications do not prove payment verification or provider infrastructure behavior.</li><li>Local deduplication does not guarantee exactly-once external side effects.</li><li>View this report on a phone; run the CLI on a computer, cloud workspace or CI host.</li>${report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><p class="muted">Share only synthetic test evidence. Reports contain declared order identifiers and event metadata, never signing keys or request headers.</p></div></div></section>
<footer class="footer"><span>Webhook Failure Lab · report schema ${report.schemaVersion}</span><span>Static HTML · JSON and JUnit artifacts accompany this report</span></footer></main></body></html>`;
}

function xml(value: unknown): string {
  const validCharacters = Array.from(String(value)).filter((character) => {
    const point = character.codePointAt(0) ?? 0;
    return (
      point === 9 ||
      point === 10 ||
      point === 13 ||
      (point >= 32 && point <= 0xd7ff) ||
      (point >= 0xe000 && point <= 0xfffd) ||
      (point >= 0x10000 && point <= 0x10ffff)
    );
  });
  return escapeHtml(validCharacters.join(""));
}

export function renderJunit(input: RunReport): string {
  const report = serializeReport(input);
  let failures = 0;
  let errors = 0;
  const cases = report.assertions.map((item) => {
    const evidence = `${item.message}\nExpected: ${stateText(item.expected)}\nObserved: ${stateText(item.actual)}`;
    let result = "";
    if (item.outcome === "failed") {
      failures++;
      result = `<failure message="Business assertion failed">${xml(evidence)}</failure>`;
    } else if (item.outcome !== "passed") {
      errors++;
      result = `<error type="${xml(item.outcome)}" message="Assertion did not pass">${xml(evidence)}</error>`;
    }
    return `<testcase classname="webhook-lab.business" name="${xml(item.name)}">${result}<system-out>${xml(evidence)}</system-out></testcase>`;
  });
  if (report.outcome === "error" || report.outcome === "cancelled" || !report.assertions.length) {
    errors++;
    cases.push(
      `<testcase classname="webhook-lab.execution" name="Run completed"><error type="${xml(report.outcome)}" message="Run did not complete successfully">${xml(report.errors.join("\n") || outcomeLabels[report.outcome])}</error></testcase>`,
    );
  } else if (report.outcome === "failed" && failures === 0) {
    failures++;
    cases.push(
      '<testcase classname="webhook-lab.execution" name="Run outcome"><failure message="Run failed without a passing business result"/></testcase>',
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${cases.length}" failures="${failures}" errors="${errors}"><testsuite name="${xml(report.name)}" tests="${cases.length}" failures="${failures}" errors="${errors}">${cases.join("")}</testsuite></testsuites>\n`;
}

export async function writeReports(
  input: RunReport,
  outputDir: string,
): Promise<{ json: string; html: string; junit: string }> {
  const report = serializeReport(input);
  await mkdir(outputDir, { recursive: true });
  const paths = {
    json: path.resolve(outputDir, "report.json"),
    html: path.resolve(outputDir, "report.html"),
    junit: path.resolve(outputDir, "junit.xml"),
  };
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(paths.html, renderHtml(report), "utf8"),
    writeFile(paths.junit, renderJunit(report), "utf8"),
  ]);
  return paths;
}
