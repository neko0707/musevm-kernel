#!/usr/bin/env python3
"""Container agent for the musevm-kernel image.

Serves a small HTTP API on port 8080 (the port the Worker proxies to) so the
/cf-containers page can see the kernel artifact baked into the image and run
a boot smoke test:

  GET  /agent/status            system stats + kernel artifact status
                                (presence, size, SHA-256 vs SHA256SUMS,
                                config path, QEMU version)
  POST /agent/kernel/boot-test  boot the bzImage under QEMU (TCG emulation,
                                no KVM here) with a serial console and
                                classify how far it got. There is no root
                                filesystem in the image, so a healthy kernel
                                ends at the VFS root-mount panic — reaching
                                that panic is the success signal.

State lives under $HOME so the agent runs unprivileged.
"""

import hashlib
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
PORT = int(os.environ.get("AGENT_PORT", "8080"))
KERNEL_VERSION = os.environ.get("KERNEL_VERSION", "7.3.1")
KERNEL_DIR = f"/opt/musevm-kernel/{KERNEL_VERSION}"
BZIMAGE = os.path.join(KERNEL_DIR, "bzImage")
CONFIG = os.path.join(KERNEL_DIR, f"config-{KERNEL_VERSION}-minimized")
SUMS = os.path.join(KERNEL_DIR, "SHA256SUMS")
BOOT_TEST_TIMEOUT = 90


def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:  # noqa: BLE001 - report anything to the caller
        return -1, str(e)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def kernel_status():
    st = {"version": KERNEL_VERSION, "dir": KERNEL_DIR,
          "config": CONFIG if os.path.exists(CONFIG) else None}
    if not os.path.exists(BZIMAGE):
        st["bzImage"] = None
        return st
    expected = None
    try:
        with open(SUMS) as f:
            for line in f:
                parts = line.split()
                if len(parts) == 2 and parts[1].endswith("bzImage"):
                    expected = parts[0]
    except OSError:
        pass
    actual = sha256_of(BZIMAGE)
    rc, qver = run(["qemu-system-x86_64", "--version"])
    st["bzImage"] = {
        "path": BZIMAGE,
        "size_bytes": os.path.getsize(BZIMAGE),
        "sha256_expected": expected,
        "sha256_actual": actual,
        "sha256_ok": (expected == actual) if expected else None,
    }
    st["qemu_version"] = qver.splitlines()[0] if qver else None
    return st


def boot_test():
    if not os.path.exists(BZIMAGE):
        return {"ran": False, "reason": "bzImage not present in image"}
    cmd = ["qemu-system-x86_64",
           "-machine", "accel=tcg", "-m", "512",
           "-kernel", BZIMAGE,
           "-append", "console=ttyS0 panic=-1",
           "-nographic", "-no-reboot", "-display", "none"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=BOOT_TEST_TIMEOUT)
        out, timed_out = r.stdout + r.stderr, False
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode(errors="replace")
               + (e.stderr or b"").decode(errors="replace"))
        timed_out = True
    banner = f"Linux version {KERNEL_VERSION}" in out
    vfs_panic = "VFS: Unable to mount root fs" in out or "end Kernel panic" in out
    if vfs_panic:
        verdict = ("booted: kernel initialized and reached the root-filesystem "
                   "mount, which panics as expected (no rootfs in image)")
    elif banner:
        verdict = "partial: kernel banner seen, root-mount point not reached"
    else:
        verdict = "failed: kernel banner not seen"
    return {"ran": True, "timed_out": timed_out, "banner_seen": banner,
            "reached_root_mount": vfs_panic, "verdict": verdict,
            "output_tail": out[-2000:]}


def system_status():
    import shutil

    up = None
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        d, rem = divmod(int(secs), 86400)
        h, rem = divmod(rem, 3600)
        m, _ = divmod(rem, 60)
        up = {"seconds": int(secs), "human": f"{d}d {h}h {m}m" if d else f"{h}h {m}m"}
    except OSError:
        pass
    load = None
    try:
        with open("/proc/loadavg") as f:
            p = f.read().split()
        load = {"1m": float(p[0]), "5m": float(p[1]), "15m": float(p[2])}
    except OSError:
        pass
    mem = None
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.split()[0])  # kB
        mem = {
            "total_mb": info.get("MemTotal", 0) // 1024,
            "available_mb": info.get("MemAvailable", 0) // 1024,
            "free_mb": info.get("MemFree", 0) // 1024,
            "swap_total_mb": info.get("SwapTotal", 0) // 1024,
            "swap_free_mb": info.get("SwapFree", 0) // 1024,
        }
    except OSError:
        pass
    disk = None
    try:
        u = shutil.disk_usage("/")
        disk = {"total_gb": round(u.total / 2**30, 2),
                "used_gb": round(u.used / 2**30, 2),
                "free_gb": round(u.free / 2**30, 2),
                "mount": "/"}
    except OSError:
        pass
    return {"uptime": up, "loadavg": load, "memory": mem, "disk_root": disk}


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/agent/status":
            self._json({"agent": "ok", "system": system_status(),
                        "kernel": kernel_status()})
        elif self.path == "/":
            self._json({"agent": "ok",
                        "hint": "control UI lives on the Worker at /cf-containers"})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/agent/kernel/boot-test":
            self._json(boot_test())
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, *args):  # keep stdout quiet
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
