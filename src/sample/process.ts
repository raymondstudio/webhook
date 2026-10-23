import type { ChildProcess } from "node:child_process";

/** Confirm termination before deleting resources that an owned process could still mutate. */
export async function terminateOwnedChild(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  // A failed spawn has no OS child and may emit `error` without ever emitting `exit`.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Owned worker did not confirm exit after SIGKILL; disposable schema retained. Stop the owned process before cleanup.",
        ),
      );
    }, timeoutMs);
    const exited = () => {
      cleanup();
      resolve();
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("exit", exited);
    }
    child.once("exit", exited);
    try {
      child.kill("SIGKILL");
      // Covers a race in which exit status was already available before the listener.
      if (child.exitCode !== null || child.signalCode !== null) exited();
    } catch {
      // Do not claim termination from an unsuccessful signal. An exit event or deadline decides.
    }
  });
}
