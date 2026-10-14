// Docker-availability probe for the Docker-dependent suites (container and,
// later, e2e): those files `skipIf` this so a Docker-less `bun test` stays
// green and honest — a skip is visible in the output, not a silent pass.
//
// The probe is `docker info` rather than a bare /var/run/docker.sock stat: it
// proves the CLI exists *and* a daemon actually answers (a socket file with a
// dead daemon would otherwise turn the suite into failures), and it honors
// DOCKER_HOST, so rootless and remote-daemon setups probe correctly too.
let cached: boolean | undefined

export const isDockerAvailable = (): boolean => {
  if (cached === undefined) {
    try {
      const probe = Bun.spawnSync({
        cmd: ['docker', 'info'],
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 10_000,
      })
      cached = probe.exitCode === 0
    } catch {
      // A missing `docker` binary (or a wedged CLI) is just "unavailable".
      cached = false
    }
    if (!cached) {
      // The visible notice the skip markers themselves cannot carry.
      console.warn('docker: unavailable — Docker-dependent suites will skip (Docker is optional for `bun test`)')
    }
  }
  return cached
}
