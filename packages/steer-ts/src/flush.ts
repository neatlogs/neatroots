/** How long a flush before a claim or a self-check may hold up the agent's call. */
export const FLUSH_TIMEOUT_MS = 500;

/** The flush under way for each SDK. */
const running = new WeakMap<object, Promise<void>>();

/**
 * Runs the SDK's flush and waits for it at most FLUSH_TIMEOUT_MS, like the Python hook. A neatroots
 * that takes the connection but doesn't answer (busy or stuck) holds the Neatlogs SDK's flush for
 * about 10 s while it retries, and the agent's call must not wait for that.
 *
 * A flush that is still running on an SDK isn't started again on that SDK.
 */
export async function boundedFlush(sdk: object, flush: () => Promise<unknown>): Promise<void> {
  let done = running.get(sdk);
  if (!done) {
    const started: Promise<void> = (async () => {
      try {
        await flush();
      } catch {
        /* ignore */
      }
    })().finally(() => {
      if (running.get(sdk) === started) running.delete(sdk);
    });
    running.set(sdk, started);
    done = started;
  }
  // A plain timer, not unref'd: the caller is waiting on it, so it must keep the process alive.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
  });
  await Promise.race([done, waited]);
  clearTimeout(timer);
}
