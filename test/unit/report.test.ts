import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderHtml, renderJunit, serializeReport, writeReports } from "../../src/report/index.js";
import { first, reportFixture } from "./report-fixture.js";

test("HTML shows delivery successes separately from executable business evidence", () => {
  const report = reportFixture();
  const html = renderHtml(report);
  assert.match(html, /2 HTTP successes/);
  assert.match(html, /Business outcomes/);
  assert.match(html, /Order fulfilled once/);
  assert.match(html, /State remained matched/);
  assert.match(html, /HTTP response does not prove/);
  assert.match(html, /not universal payment correctness/);
  assert.match(html, /no live loading or background refresh/);
});

test("malicious text is escaped across HTML content and attribute contexts", () => {
  const report = reportFixture();
  const injection = '</title><script>globalThis.pwned=true</script><img src=x onerror="alert(1)">';
  report.name = injection;
  report.runId = injection;
  report.seed = injection;
  report.assertions[0] = {
    ...first(report.assertions),
    name: injection,
    message: injection,
    actual: { status: injection, fulfilmentCount: 1 },
  };
  first(report.attempts).eventId = injection;
  report.errors.push(injection);
  report.limitations.push(injection);
  const html = renderHtml(report);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;alert\(1\)&quot;/);
  assert.match(html, /default-src 'none'/);
  assert.match(renderJunit(report), /&lt;script&gt;/);
});

test("export whitelists metadata, omits signing/env/extras and sanitizes endpoint secrets", () => {
  const report = reportFixture();
  Object.assign(report, { signingSecret: "must-not-export", databaseUrl: "must-not-export" });
  Object.assign(report.config, {
    signingSecretEnv: "TEST_SECRET",
    headers: { authorization: "must-not-export" },
  });
  Object.assign(first(report.config.events), { arbitraryPayload: "must-not-export" });
  report.config.target =
    "http://user:must-not-export@127.0.0.1:3000/webhook?token=must-not-export#secret";
  first(report.config.assertions).url = "http://127.0.0.1:3000/state?key=must-not-export";
  const serialized = JSON.stringify(serializeReport(report));
  assert.ok(!serialized.includes("must-not-export"));
  assert.ok(!serialized.includes("signingSecret"));
  assert.ok(!serialized.includes("authorization"));
  assert.match(serialized, /1200/);
  assert.match(serialized, /http:\/\/127.0.0.1:3000\/webhook/);
});

test("empty, partial or contradictory reports cannot export a green outcome", () => {
  const empty = reportFixture();
  empty.assertions = [];
  empty.attempts = [];
  assert.equal(serializeReport(empty).outcome, "error");
  assert.match(renderHtml(empty), /No assertions executed/);
  assert.match(renderHtml(empty), /Execution error/);
  assert.match(renderJunit(empty), /errors="1"/);
  assert.match(renderJunit(empty), /<error /);
  const partial = reportFixture();
  partial.finishedAt = "";
  assert.equal(serializeReport(partial).outcome, "error");
  const contradictory = reportFixture();
  first(contradictory.assertions).outcome = "timed-out";
  assert.equal(serializeReport(contradictory).outcome, "error");
  assert.match(renderJunit(contradictory), /type="timed-out"/);
  const missingEvidence = reportFixture();
  first(missingEvidence.assertions).observations = 0;
  assert.equal(serializeReport(missingEvidence).outcome, "error");
});

test("JUnit distinguishes business failure, adapter error and cancellation without skips", () => {
  const failure = reportFixture();
  failure.outcome = "failed";
  first(failure.assertions).outcome = "failed";
  first(failure.assertions).actual = { status: "paid", fulfilmentCount: 2 };
  const xml = renderJunit(failure);
  assert.match(xml, /failures="1" errors="0"/);
  assert.match(xml, /2 fulfilment\(s\)/);
  assert.match(xml, /<failure /);
  const error = reportFixture();
  error.outcome = "error";
  first(error.assertions).outcome = "error";
  assert.match(renderJunit(error), /errors="2"/);
  assert.ok(!renderJunit(error).includes("<skipped"));
  const cancelled = reportFixture();
  cancelled.outcome = "cancelled";
  assert.match(renderJunit(cancelled), /type="cancelled"/);
});

test("JUnit removes XML-disallowed control characters and escapes names", () => {
  const report = reportFixture();
  report.name = 'test\u0000 & "name"';
  first(report.assertions).name = "<assertion>\u0001";
  const xml = renderJunit(report);
  assert.ok(!xml.includes("\u0000"));
  assert.ok(!xml.includes("\u0001"));
  assert.match(xml, /&amp; &quot;name&quot;/);
  assert.match(xml, /&lt;assertion&gt;/);
});

test("writer emits three bounded filenames and preserves unrelated artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "webhook-report-"));
  try {
    const report = reportFixture();
    report.runId = "../../escape";
    const paths = await writeReports(report, directory);
    assert.deepEqual((await readdir(directory)).sort(), [
      "junit.xml",
      "report.html",
      "report.json",
    ]);
    assert.equal(paths.html, path.join(directory, "report.html"));
    assert.equal(JSON.parse(await readFile(paths.json, "utf8")).outcome, "passed");
    assert.match(await readFile(paths.html, "utf8"), /Concurrent payment duplicates/);
    assert.match(await readFile(paths.junit, "utf8"), /tests="1" failures="0" errors="0"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial delivery or assertion coverage cannot masquerade as a passed run", () => {
  const partialDelivery = reportFixture();
  partialDelivery.attempts.pop();
  assert.equal(serializeReport(partialDelivery).outcome, "error");

  const wrongEvent = reportFixture();
  first(wrongEvent.attempts).eventId = "different-event";
  assert.equal(serializeReport(wrongEvent).outcome, "error");

  const failedFinalAttempt = reportFixture();
  failedFinalAttempt.attempts.push({
    ...first(failedFinalAttempt.attempts),
    attempt: 2,
    outcome: "timeout",
    status: null,
  });
  assert.equal(serializeReport(failedFinalAttempt).outcome, "error");

  const duplicateAssertions = reportFixture();
  const configured = first(duplicateAssertions.config.assertions);
  duplicateAssertions.config.assertions.push({ ...configured, name: "Second order" });
  duplicateAssertions.assertions.push({ ...first(duplicateAssertions.assertions) });
  assert.equal(serializeReport(duplicateAssertions).outcome, "error");

  const wrongEvidence = reportFixture();
  first(wrongEvidence.assertions).actual = { status: "paid", fulfilmentCount: 2 };
  assert.equal(serializeReport(wrongEvidence).outcome, "error");

  const changedExpectation = reportFixture();
  first(changedExpectation.assertions).expected = { status: "paid", fulfilmentCount: 2 };
  first(changedExpectation.assertions).actual = { status: "paid", fulfilmentCount: 2 };
  assert.equal(serializeReport(changedExpectation).outcome, "error");
});

test("successful retry completes delivery coverage and normalization is repeatable", () => {
  const report = reportFixture();
  first(report.attempts).outcome = "timeout";
  first(report.attempts).status = null;
  report.attempts.push({
    ...first(report.attempts),
    attempt: 2,
    outcome: "http-success",
    status: 200,
  });
  assert.equal(serializeReport(report).outcome, "passed");
  report.assertions = [];
  const normalized = serializeReport(report);
  assert.deepEqual(serializeReport(normalized), normalized);
});
