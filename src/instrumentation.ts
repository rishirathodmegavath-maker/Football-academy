// Runs once when the Node.js server starts (not in the edge runtime or at build).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installShutdownHandlers } = await import("./server/shutdown");
  installShutdownHandlers();
  const { log, errorFields } = await import("./server/log");
  // Observes (does not handle) a crash: the process still ends and systemd
  // restarts it, but the reason is in the log as a structured line first.
  process.on("uncaughtExceptionMonitor", (error, origin) =>
    log("error", "process.crashed", { origin, ...errorFields(error) }),
  );
  const { logStartup } = await import("./server/startup-diagnostics");
  logStartup();
}
