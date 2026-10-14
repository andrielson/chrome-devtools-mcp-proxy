// Shared polling for the Docker suites: `up --wait` gates on containers
// running, not on HTTP listeners answering, so probes must repeat until the
// service is really there.
//
// Poll `probe` every `interval` ms until it returns a value or `timeout` ms
// pass, then throw `timeoutError()` — callers capture docker logs there. A
// probe that cannot answer yet returns undefined (transient errors — a refused
// connection, a wedged CLI — are the probe's own business to swallow); a
// probe that wants to fail fast may throw, and the throw propagates.
export const pollUntil = async <T>(
  probe: () => Promise<T | undefined>,
  timeout: number,
  interval: number,
  timeoutError: () => Promise<Error>,
): Promise<T> => {
  const deadline = Date.now() + timeout
  for (;;) {
    const found = await probe()
    if (found !== undefined) return found
    if (Date.now() >= deadline) throw await timeoutError()
    await Bun.sleep(interval)
  }
}
