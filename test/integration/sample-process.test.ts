import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { terminateOwnedChild } from "../../src/sample/process.js";

test("owned-child cleanup handles a real failed spawn that never emits exit", async () => {
  const child = spawn("/nonexistent-webhook-lab-test-executable", [], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("error", () => resolve()));
  assert.equal(child.pid, undefined);
  await terminateOwnedChild(child, 50);
});

test("owned-child cleanup confirms SIGKILL exit for its actual local child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  await terminateOwnedChild(child);
  assert.equal(child.signalCode, "SIGKILL");
  await terminateOwnedChild(child);
});

test("unconfirmed child termination has a bounded error rather than false cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const realKill = child.kill.bind(child);
  child.kill = () => false; // Model signal refusal while keeping a real owned process to clean up.
  try {
    await assert.rejects(terminateOwnedChild(child, 30), /schema retained/);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    child.kill = realKill;
    await terminateOwnedChild(child);
  }
});
