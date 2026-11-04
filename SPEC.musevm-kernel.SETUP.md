# SPEC.musevm-kernel.SETUP

Setup and configuration spec for the musevm-kernel Workers + Containers
project. This repository holds the minimized kernel artifact AND the
Worker/container project that carries it, mirroring the musevm repository's
structure.

## 1. Account wiring (one-time, Cloudflare dashboard)

1. Create a Worker named exactly `musevm-kernel-worker`.
2. Settings > Builds > Connect repository `neko0707/musevm-kernel`:
   - Root directory: repo root
   - Deploy command: `npx wrangler deploy`
   - Production branch: `main`
3. Optional secret: `wrangler secret put CONTROL_TOKEN` — when set, the
   /cf-containers control API requires HMAC-SHA256 signatures (see §4).
   When unset, the API is unauthenticated; put the Worker behind
   Cloudflare Access in that case.

## 2. Fixed values (wrangler.toml)

- Container class `KernelContainer`, image `./Dockerfile`
- `instance_type = "basic"` (1/4 vCPU, 1 GiB RAM, 4 GB disk), max_instances 1
- Durable Object binding `KERNEL_CONTAINER`, migration `v1`
- Agent port 8080 (container defaultPort), sleepAfter 10m, instance name `main`

## 3. Image contents (Dockerfile)

- Stage 1 reassembles the bzImage for `KERNEL_VERSION` (ARG, default 7.3.1)
  from `<version>/bzImage.b64.part-*` and verifies `sha256sum -c SHA256SUMS`.
  The chunks themselves do not enter the final image.
- Final image (Debian trixie-slim):
  - `/opt/musevm-kernel/<version>/` — verified bzImage, its .config,
    SHA256SUMS
  - Kernel build toolchain (per Documentation/process/changes.rst),
    including gawk and the zstd CLI — both are hard requirements that are
    easy to miss (gawk: modules.builtin.ranges; zstd: CONFIG_KERNEL_ZSTD)
  - `qemu-system-x86` for the boot smoke test (TCG emulation, no KVM)
  - Minimal userland (procps, psmisc, less, vim-tiny, python3, curl, git)
  - `container-agent.py` as CMD, non-root `builder` user, WORKDIR /src
- The container does NOT boot this kernel as its host kernel; Cloudflare
  Containers always run on Cloudflare's kernel. The bzImage is cargo and
  the QEMU test subject.

## 4. Control page (/cf-containers)

Served by the Worker; the page itself and `/health` are outside the auth
branch. When CONTROL_TOKEN is set it is an HMAC-SHA256 key: signed message
`"<METHOD>\n<path>\n<timestamp>"` (Unix seconds), headers `X-Timestamp` and
`X-Signature` (64-char lowercase hex); skew over 300 s is rejected with 401.
The secret value is never transmitted; the page signs in-browser.

Panels:
- HTTPS health check (Worker /health)
- Container lifecycle: start / stop / restart / status. Buttons are
  state-aware (running: Start is a filled green lamp, disabled; Stop is a
  yellow outline. stopped: Start is a green outline; Stop is disabled).
  All actions ask for confirmation in a modal first. Stop escalates to
  destroy() when the instance does not reach `stopped`.
- Kernel artifact: agent status — bzImage presence, size, SHA-256 vs
  SHA256SUMS, config path, QEMU version.
- Boot test: POST agent/kernel/boot-test — QEMU boots the bzImage with a
  serial console (max 90 s). The image has no root filesystem, so a healthy
  kernel ends at the VFS root-mount panic; reaching that panic is the
  success signal. The panel shows the verdict and the serial output tail.
- System: uptime, load, memory, root disk.

Behavioural notes:
- Agent API calls are gated: while the instance is `stopped`, the Worker
  returns 503 `{error: "container is stopped"}` without fetching the stub,
  so page refreshes never wake a stopped container. Only the lifecycle
  panel's Start (RPC) wakes it.
- Container filesystem is ephemeral; nothing in the image needs writable
  state beyond $HOME scratch.

## 5. Adding a new kernel version

1. Build the kernel, then add `<version>/` with the Base64 chunks
   (2 MiB parts), `config-<version>-minimized` and `SHA256SUMS`.
2. Set the Dockerfile/wrangler build ARG: Workers Builds builds with the
   Dockerfile's default `KERNEL_VERSION` — update the ARG default to the
   new version (and `KERNEL_VERSION` env in the Dockerfile).
3. Push to `main`; Workers Builds rebuilds and redeploys.

## 6. Deploy & verify checklist

- [ ] Worker `musevm-kernel-worker` connected to `neko0707/musevm-kernel`
      (root = repo root, deploy command `npx wrangler deploy`, branch main)
- [ ] First build passes (image build includes the SHA-256 check)
- [ ] `GET /health` returns `ok`
- [ ] `/cf-containers` opens; container Start reaches healthy
- [ ] Kernel artifact panel shows `sha256_ok: true`
- [ ] Boot test verdict: reached the root-mount panic (expected success)
- [ ] Stop reaches `stopped` and stays stopped
