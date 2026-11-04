# musevm-kernel container image: the minimized kernel artifact plus the
# toolchain and test tooling around it.
#
# The bzImage is stored in this repository as Base64 chunks (the publishing
# path is text-only). Stage 1 reassembles it and verifies SHA256SUMS; the
# final image carries only the verified bzImage and its .config, not the
# chunks.
#
# Related packages, and why they are here:
#   kernel build (Documentation/process/changes.rst): build-essential,
#     flex, bison, bc, gawk, perl, libelf-dev, libssl-dev, dwarves (pahole),
#     cpio, xz-utils, zstd, kmod, rsync, libncurses-dev (menuconfig)
#     — gawk and zstd are easy to miss: kbuild needs gawk for
#       modules.builtin.ranges and the zstd CLI for CONFIG_KERNEL_ZSTD.
#   boot test: qemu-system-x86 runs the bzImage under TCG emulation
#     (no KVM in this environment) for a serial-console smoke test.
#   runtime: python3 runs the container agent; procps/psmisc/less are the
#     minimal inspection userland; curl/git/ca-certificates fetch sources.
#
# Nothing here boots the kernel as the host kernel — Cloudflare Containers
# always run on Cloudflare's kernel. The bzImage is cargo + test subject.

FROM debian:trixie-slim AS artifact
ARG KERNEL_VERSION=7.3.1
COPY ${KERNEL_VERSION}/ /artifact/
RUN cd /artifact \
    && cat bzImage.b64.part-* | base64 -d > bzImage \
    && sha256sum -c SHA256SUMS \
    && rm bzImage.b64.part-*

FROM debian:trixie-slim
ARG KERNEL_VERSION=7.3.1
ENV DEBIAN_FRONTEND=noninteractive
ENV KERNEL_VERSION=${KERNEL_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        flex bison bc gawk perl \
        libelf-dev libssl-dev dwarves \
        cpio xz-utils zstd kmod rsync \
        libncurses-dev \
        qemu-system-x86 \
        procps psmisc less vim-tiny python3 \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# Verified kernel artifact: /opt/musevm-kernel/<version>/{bzImage,config-*,SHA256SUMS}
COPY --from=artifact /artifact/ /opt/musevm-kernel/${KERNEL_VERSION}/

# Container agent: the long-running process for Cloudflare Containers.
# Serves the status/control API on 8080 that the Worker's /cf-containers
# page talks to (kernel artifact status, QEMU boot smoke test, system).
COPY --chmod=755 container-agent.py /usr/local/bin/container-agent.py

RUN useradd -m -s /bin/bash builder
USER builder
WORKDIR /src

CMD ["/usr/local/bin/container-agent.py"]
