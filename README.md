# musevm-kernel

Minimized Linux kernel boot images for the musevm project.

## Layout

One directory per kernel version:

```text
<version>/
  bzImage.b64.part-00 ...   bzImage, Base64-encoded, split into 2 MiB chunks
                            (the publishing path is text-only, hence Base64)
  config-<version>-minimized  the exact .config the image was built with
  SHA256SUMS                  SHA-256 of the reassembled bzImage
```

## Current image: 7.3.1

- Linux 7.3.1, x86_64, 1,990 enabled options, all built-in, no modules
- Kernel compression: ZSTD
- bzImage size: 13,361,664 bytes
- Device scope: virtio (net/blk/rng/balloon/vsock), btrfs, device-mapper,
  overlayfs, ext4, tmpfs, serial console, IPv4/IPv6, namespaces/cgroups
- Built 2026-11-04. Boot verification on the target is still pending.

## Reassemble

```sh
cd 7.3.1
cat bzImage.b64.part-* | base64 -d > bzImage
sha256sum -c SHA256SUMS
```

## Workers + Containers

This repository is also a Cloudflare Workers + Containers project (same
structure as the musevm repository):

- `wrangler.toml` — Worker `musevm-kernel-worker`, container class
  `KernelContainer`, basic instance, Durable Object binding.
- `Dockerfile` — multi-stage: stage 1 reassembles and SHA-256-verifies the
  bzImage from the chunks above; the final image (Debian trixie-slim)
  carries the verified artifact at `/opt/musevm-kernel/<version>/`, the
  kernel build toolchain, QEMU for boot testing, and the agent-managed
  daemons (tailscaled 1.104.5, cloudflared 2026.10.7, Apache httpd 2.4.69
  built from source on :8081).
- `src/index.ts` — Worker with a `/cf-containers` control page: container
  start/stop/restart/status, kernel artifact status, a QEMU boot
  smoke test (the image has no root filesystem, so reaching the VFS
  root-mount panic is the success signal), and Tailscale / cloudflared /
  Apache panels with status and start/stop (daemon secrets TS_AUTHKEY
  and TUNNEL_TOKEN are set per-Worker with `wrangler secret put`).
  Optional `CONTROL_TOKEN` secret enables HMAC-signed control API access.
- `container-agent.py` — in-container agent on port 8080 backing the
  control page.
- `SPEC.musevm-kernel.SETUP.md` — full setup spec and deploy checklist.

Connect this repository in Workers Builds (Worker name
`musevm-kernel-worker`, root directory = repo root, deploy command
`npx wrangler deploy`, production branch `main`) and pushes to `main`
build and deploy the container automatically.
