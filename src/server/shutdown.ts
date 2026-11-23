import "server-only";
import { database } from "./database";
import { log } from "./log";

const state = globalThis as typeof globalThis & {
  sportozenDraining?: boolean;
  sportozenShutdownInstalled?: boolean;
};
/** How long to wait for the framework to finish in-flight requests and exit
 * on its own after a termination signal, before exiting anyway. */
export const SHUTDOWN_GRACE_MS = 10_000;

export const isDraining = () => state.sportozenDraining === true;

/** Folds the write-ahead log into the main file and closes the connection, so
 * the file on disk is complete without its -wal and -shm companions. Safe to
 * call when the database was never opened, and more than once. */
export function closeDatabaseCleanly(): boolean {
  const connections = globalThis as typeof globalThis & {
    sportozenDatabase?: ReturnType<typeof database>;
  };
  const db = connections.sportozenDatabase;
  if (!db) return false;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Another connection (the worker) may be reading; SQLite replays the log
    // on the next open, so nothing is lost.
  }
  try {
    db.close();
  } catch {
    return false;
  }
  connections.sportozenDatabase = undefined;
  return true;
}

/** Installs once per process. `exit` runs for process.exit() and normal ends,
 * which is how the framework stops after SIGTERM; the signal handler marks the
 * service as draining (readiness turns 503 so the proxy stops sending traffic)
 * and guarantees an exit if the framework does not stop by itself. */
export function installShutdownHandlers(proc: NodeJS.Process = process) {
  if (state.sportozenShutdownInstalled) return;
  state.sportozenShutdownInstalled = true;
  proc.on("exit", (code) => {
    const closed = closeDatabaseCleanly();
    log("info", "app.stopped", { code, databaseClosedCleanly: closed });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    proc.on(signal, () => {
      log("info", "app.stopping", { signal });
      state.sportozenDraining = true;
      setTimeout(() => proc.exit(0), SHUTDOWN_GRACE_MS).unref();
    });
}
