# Running this repo in a Claude Code web session

Notes on getting an ephemeral Claude Code container able to run this project's
verification. Written 2026-09-15 while executing Phase 8, where several plans verify
with `docker compose`.

Companion to `VENDORING.md` in this directory. Neither file is part of Legion.

---

## Docker

### Symptom

`docker` is installed but nothing works:

```
$ docker info
failed to connect to the docker API at unix:///var/run/docker.sock;
check if the path is correct and if the daemon is running:
dial unix /var/run/docker.sock: connect: no such file or directory
```

### Cause

The **daemon is not started**. The binaries are all present — this is not a missing
install, and nothing needs to be fetched:

```bash
command -v dockerd containerd runc
# /usr/bin/dockerd
# /usr/bin/containerd
# /usr/bin/runc
```

There is no systemd in the container, so `systemctl start docker` is not available.

### Fix

Start the daemon directly, as root, detached:

```bash
nohup dockerd > /tmp/dockerd.log 2>&1 &
sleep 8
docker info --format '{{.ServerVersion}} | storage={{.Driver}} | cgroup={{.CgroupDriver}}'
# 29.3.1 | storage=overlayfs | cgroup=cgroupfs
```

That is the whole fix. Notably **not** needed, despite being the usual advice for
Docker-in-Docker:

- no `--privileged` / capability juggling
- no `--storage-driver=vfs` fallback (overlayfs works)
- no `--iptables=false`
- no rootless (`dockerd-rootless.sh`) setup

If it fails, read `/tmp/dockerd.log` — that is where the daemon's output goes.

### Restarting after the daemon has died

A daemon that was killed rather than shut down leaves a **stale pidfile**, and the next
start refuses:

```
failed to start daemon, ensure docker is not running or delete /var/run/docker.pid:
process with PID 399 is still running
```

The named PID is usually gone — confirm before deleting anything:

```bash
ps -o pid,cmd -p "$(cat /var/run/docker.pid)"   # empty output = stale
```

If it is stale, clear both the pidfile and the orphaned socket, then start as above:

```bash
rm -f /var/run/docker.pid /var/run/docker.sock
nohup dockerd > /tmp/dockerd.log 2>&1 &
```

Pulled images live on disk and **survive** the restart; only the daemon process is lost.

### Verify it actually works

A running daemon is not the same as a *useful* one. Walk up the ladder, because each
step can fail independently:

```bash
# 1. Compose plugin present
docker compose version                       # Docker Compose version v5.1.1

# 2. Registry reachable through the session's HTTPS proxy
docker pull alpine:3.20

# 3. Containers actually execute
docker run --rm alpine:3.20 sh -c 'echo ok'

# 3b. NOTE: `docker compose config` is client-side only and exits 0 even with no
#     daemon running. It is not a daemon health check — do not use it as one.

# 4. The check this project's Phase 8 plans need.
#    Use a throwaway env: the compose file uses `${VAR:?...}` guards, so a bare
#    `docker compose config` exits non-zero by design in a clean checkout with no
#    .env. That is the guard working, NOT a parse failure — do not "fix" it by
#    weakening a `:?` to `:-`.
POSTGRES_PASSWORD=validate SITE_ADDRESS=example.test AUTH_URL=https://example.test \
  docker compose config -q
```

### Pre-pull the images the stack needs

Optional, but it turns a slow surprise mid-verification into an upfront check:

```bash
docker pull caddy:alpine        #  88.7 MB
docker pull postgres:16-alpine  # 420 MB
```

### Caveats

- **Ephemeral.** The daemon is a plain background process. It dies with the container,
  and the container is reclaimed after inactivity. Re-run the `nohup dockerd` line in
  each new session.
- **HTTP-01 TLS cannot complete here.** Let's Encrypt must reach the host on port 80
  from the public internet; a session container has no public DNS and no inbound route.
  Caddy will start, serve, and keep retrying the challenge. Redirect behaviour is
  testable; a real trusted certificate is not. Any check that depends on a valid cert
  must be reported as *not executed* rather than assumed.
- **Bringing the full stack up builds the app image** (`npm ci` + `next build` inside
  Docker) — several minutes. Worth it as a signal, since it catches build-time problems
  `tsc --noEmit` alone does not.

---

## Node dependencies

`node_modules` is **not** present in a fresh session. Three separate steps, and missing
any of them produces failures that look unrelated to the real cause:

```bash
npm install          # 653 packages
npx prisma generate  # writes node_modules/@prisma/client; config from prisma7.config.ts
npx next typegen     # writes .next/types, which tsconfig.json:29-30 includes
```

Skipping the last two makes `npx tsc --noEmit` fail with **~81 errors** that have nothing
to do with your change — `'@prisma/client' has no exported member 'PrismaClient'`,
`LayoutProps` not found, and a long cascade of implicit-`any`. Establish a clean
`tsc --noEmit` / `npm run lint` baseline **before** editing, so a green result afterwards
is attributable to the work rather than to setup.

### One gotcha

`npm install` may leave a one-line incidental change in `package-lock.json` (npm
re-resolving `fsevents` as `dev`). It is an install artifact, not intended work, and
`package-lock.json` is in `files_forbidden` for every Phase 8 plan. Revert it:

```bash
git checkout -- package-lock.json
```

This matches the convention Phase 5 set, where `prisma migrate dev` auto-wrote an
`allowScripts` block into a forbidden `package.json` and it was reverted the same way.
