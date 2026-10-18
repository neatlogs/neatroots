/** One stop operation shared by both signals; cleanup has a final process-exit deadline. */
export function createShutdown(
  close: () => void | Promise<void>,
  exit: (code: number) => void,
  log: (message: string) => void,
  timeoutMs = 15_000,
): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    if (stopping) return stopping;
    stopping = (async () => {
      log("stopping");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let code = 0;
      try {
        await Promise.race([
          Promise.resolve().then(close),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("deadline")), timeoutMs); }),
        ]);
      } catch {
        code = 1;
        log("shutdown cleanup did not complete");
      } finally { clearTimeout(timeout); }
      exit(code);
    })();
    return stopping;
  };
}
