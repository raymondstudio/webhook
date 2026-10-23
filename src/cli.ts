#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfig, runScenario } from "./engine/index.js";
import { writeReports } from "./report/index.js";

const help = `Webhook Failure Lab 0.1.0\n\nUsage: webhook-lab run <scenario.json> --out <directory>\n\nSet the dedicated test signing secret through the scenario's signingSecretEnv\n(default LAB_SIGNING_SECRET). Never put secrets in the JSON file.\n\nExit codes: 0 business assertions passed; 1 business assertion mismatch;\n2 configuration, delivery, adapter or deadline error; 130 cancelled.\nSynthetic tests only; HTTP acknowledgement does not prove business success.\n`;

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return 0;
  }
  if (args.length !== 4 || args[0] !== "run" || args[2] !== "--out" || !args[1] || !args[3]) {
    console.error("Invalid arguments. Use webhook-lab --help.");
    return 2;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const file = resolve(args[1]);
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 1_048_576) {
      console.error("Scenario must be a JSON file of at most 1 MiB.");
      return 2;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      console.error("Scenario file could not be read as valid JSON.");
      return 2;
    }
    const report = await runScenario(parseConfig(raw), { signal: controller.signal });
    await writeReports(report, resolve(args[3]));
    console.log(
      `${report.outcome}: ${report.assertions.filter((item) => item.outcome === "passed").length}/${report.assertions.length} business assertions passed; ${report.attempts.length} delivery attempts. Reports written.`,
    );
    return report.outcome === "passed"
      ? 0
      : report.outcome === "failed"
        ? 1
        : report.outcome === "cancelled"
          ? 130
          : 2;
  } catch {
    console.error(
      "Scenario execution or report writing failed. Check the configuration, endpoint policy, file permissions and --help.",
    );
    return controller.signal.aborted ? 130 : 2;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
