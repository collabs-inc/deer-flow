# DeerFlow in Cube

Install `https://github.com/collabs-inc/deer-flow` in Cube. The `cube-app`
branch packages upstream v2.1.0 with its published Linux x64 backend/frontend
images pinned by digest in `images.json`. No Next.js or Python dependency build
happens on the cloud machine.

The machine needs Node 22+, util-linux and rootless Docker. `install.mjs` pulls
both images and warms migrations before Cube's startup deadline. `start.sh`
ensures the shared Docker daemon is ready, then holds an exclusive app lock and
supervises the two containers through one foreground Node process. Only loopback
ports are published. The proxy serves the upstream UI, preserves streaming and
WebSockets, and rejects foreign browser origins.

Persistent data is `${XDG_DATA_HOME:-$HOME/.local/share}/cube-deerflow`, or
`CUBE_DEERFLOW_DATA_DIR`: SQLite history, config, extensions, skills and generated
workspace files. Defaults are seeded once. Updates preserve user settings. The
gateway's local sandbox executes inside its private container; it does not
mount the host filesystem or Docker socket.

The initial model uses DeerFlow's Claude provider and a read-only bind mount of
`~/.claude/.credentials.json` (or `CLAUDE_CODE_CREDENTIALS_PATH`). The adapter
checks for that file but never reads or prints its contents. It does not expose
the rest of the Claude profile. Restart DeerFlow after a CLI login replaces the
file. A missing/expired login requires provider setup; loading the UI does not
prove a successful model request.

This is a trusted single-user deployment behind Cube's authenticated gate.
DeerFlow's documented local auth-disabled mode supplies its default user. The
adapter checks hosts/origins and has no public unauthenticated listener. Do not
publish inner container ports independently. Use normal DeerFlow authentication
for a shared deployment.

Docker state persists under `~/.local/share/docker`. The readiness helper uses
`~/.docker/run/docker.sock`; it never stops an existing daemon. Host packages
and `/dev/net/tun` permissions may need provisioning after a machine image roll.
No image roll or machine restart is part of this app installation.

Validation: `node --test cube/proxy.test.mjs`, `node --check cube/start.mjs`,
`sh -n cube/start.sh`, and Linux first-start/warm-up against both real image
digests. Cloud gate/browser and restart checks are recorded in the Cube handoff.
