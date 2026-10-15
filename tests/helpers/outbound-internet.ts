// Outbound-internet probe for the e2e smoke: the suite's page load happens
// inside the fixture's Chrome, so "is there internet" must be answered from a
// container — the session's own connectivity says nothing about the daemon
// host's egress. The probe one-shots the fixture's pinned curl image against
// the exact page the smoke loads; any HTTP response (a redirect included)
// proves the egress path, while only curl's own network failures (DNS, TCP,
// TLS, timeout) exit nonzero. Like the Docker probe, it `skipIf`s with a
// visible notice so an offline `bun test` stays green and honest.
//
// Docker is a precondition — callers short-circuit before probing when
// isDockerAvailable() is false (describe.skipIf evaluates left to right).
let cached: boolean | undefined

export const isOutboundInternetAvailable = (): boolean => {
  if (cached === undefined) {
    try {
      const probe = Bun.spawnSync({
        cmd: [
          'docker',
          'run',
          '--rm',
          'docker.io/curlimages/curl:8.10.1',
          '--silent',
          '--output',
          '/dev/null',
          '--max-time',
          '20',
          'https://developers.chrome.com',
        ],
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 45_000,
      })
      cached = probe.exitCode === 0
    } catch {
      // A wedged CLI (or an image that cannot even be pulled — an offline
      // machine cannot pull it either) is just "unavailable".
      cached = false
    }
    if (!cached) {
      // The visible notice the skip markers themselves cannot carry.
      console.warn(
        'internet: unreachable from containers — the e2e smoke will skip (it loads the real developers.chrome.com page)',
      )
    }
  }
  return cached
}
