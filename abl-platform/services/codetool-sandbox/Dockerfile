# ============================================================
# Stage 1: Build rootfs with Python + Node.js + deps
# ============================================================
FROM ubuntu:22.04 AS rootfs-builder

RUN apt-get update && apt-get install -y \
    debootstrap qemu-user-static wget curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Create rootfs via debootstrap (architecture-aware)
RUN DPKG_ARCH=$(dpkg --print-architecture) && \
    if [ "$DPKG_ARCH" = "arm64" ]; then \
      MIRROR="http://ports.ubuntu.com/ubuntu-ports/"; \
    else \
      MIRROR="http://archive.ubuntu.com/ubuntu/"; \
    fi && \
    debootstrap --arch=$DPKG_ARCH jammy rootfs $MIRROR

# Remove ubuntu-advantage-tools from rootfs (Go 1.18 binary with CVEs)
RUN rm -f /build/rootfs/usr/lib/ubuntu-advantage/apt-esm-json-hook 2>/dev/null; \
    chroot /build/rootfs/ apt-get purge -y ubuntu-advantage-tools 2>/dev/null || true

# Configure apt sources inside rootfs
RUN DPKG_ARCH=$(dpkg --print-architecture) && \
    if [ "$DPKG_ARCH" = "arm64" ]; then \
      MIRROR="http://ports.ubuntu.com/ubuntu-ports"; \
      SEC_MIRROR="http://ports.ubuntu.com/ubuntu-ports"; \
    else \
      MIRROR="http://archive.ubuntu.com/ubuntu"; \
      SEC_MIRROR="http://security.ubuntu.com/ubuntu"; \
    fi && \
    chroot /build/rootfs/ /bin/bash -c "echo \"deb $MIRROR jammy main universe restricted multiverse\" > /etc/apt/sources.list" && \
    chroot /build/rootfs/ /bin/bash -c "echo \"deb $MIRROR jammy-updates main universe restricted multiverse\" >> /etc/apt/sources.list" && \
    chroot /build/rootfs/ /bin/bash -c "echo \"deb $SEC_MIRROR jammy-security main universe restricted multiverse\" >> /etc/apt/sources.list" && \
    chroot /build/rootfs/ /bin/bash -c 'apt-get update'

# Install Python 3.12 inside rootfs — use deadsnakes PPA instead of compiling from source
RUN chroot /build/rootfs/ /bin/bash -c 'apt-get update && \
    apt-get install -y software-properties-common && \
    add-apt-repository -y ppa:deadsnakes/ppa && \
    apt-get update && \
    apt-get install -y python3.12 python3.12-venv python3.12-dev python3-pip && \
    ln -sf /usr/bin/python3.12 /usr/local/bin/python3 && \
    python3.12 -m ensurepip && \
    ln -sf /usr/local/bin/pip3.12 /usr/local/bin/pip3 && \
    pip3 install --upgrade pip && \
    apt-get remove -y software-properties-common && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*'

# Create venv
RUN chroot /build/rootfs/ /bin/bash -c "python3 -m venv exec_env --system-site-packages && \
    exec_env/bin/python3 -m ensurepip && \
    exec_env/bin/pip install --upgrade pip"

# Install NVM + Node.js inside rootfs
RUN chroot /build/rootfs/ /bin/bash -c 'apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*'
RUN chroot /build/rootfs/ /bin/bash -c 'mkdir -p /opt/.nvm'
RUN chroot /build/rootfs/ /bin/bash -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | NVM_DIR=/opt/.nvm bash'

COPY runtime_js/package.json /build/rootfs/package.json
RUN chroot /build/rootfs/ /bin/bash -c 'export NVM_DIR="/opt/.nvm" && \
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && \
    nvm install 22.22.0 && \
    nvm use 22.22.0 && \
    nvm alias default 22.22.0 && \
    npm install --legacy-peer-deps && \
    npm cache clean --force'

# Install Python deps inside rootfs
COPY requirements_codetool.txt /build/rootfs/requirements.txt
RUN chroot /build/rootfs/ /bin/bash -c "exec_env/bin/pip install -r requirements.txt"

COPY memory_service_sdk-0.1.0-py3-none-any.whl /build/rootfs/memory_service_sdk-0.1.0-py3-none-any.whl
RUN chroot /build/rootfs/ /bin/bash -c "exec_env/bin/pip install memory_service_sdk-0.1.0-py3-none-any.whl"

# Clean up caches to reduce size
RUN rm -rf /build/rootfs/var/lib/apt/lists/* \
    /build/rootfs/root/.npm/_cacache \
    /build/rootfs/tmp/* \
    /build/rootfs/memory_service_sdk-0.1.0-py3-none-any.whl \
    /build/rootfs/requirements.txt

# ============================================================
# Stage 2: Final runtime image (no build tools)
# ============================================================
FROM ubuntu:22.04

RUN groupadd -g 1024 kore && useradd -l -u 1024 -g 1024 kore

RUN apt-get update && apt-get install -y \
    curl ca-certificates sudo unzip wget \
    iproute2 iptables dnsutils ipset \
    python3 python3-pip \
    libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

# Remove ubuntu-advantage-tools (Go 1.18 binary with CVEs)
RUN rm -f /usr/lib/ubuntu-advantage/apt-esm-json-hook 2>/dev/null; \
    apt-get purge -y ubuntu-advantage-tools 2>/dev/null || true; \
    rm -rf /var/lib/apt/lists/*

# Install gVisor
RUN set -e && \
    ARCH=$(uname -m) && \
    URL=https://storage.googleapis.com/gvisor/releases/release/20250811/${ARCH} && \
    wget ${URL}/runsc ${URL}/runsc.sha512 \
         ${URL}/containerd-shim-runsc-v1 ${URL}/containerd-shim-runsc-v1.sha512 && \
    sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512 && \
    rm -f *.sha512 && \
    chmod a+rx runsc containerd-shim-runsc-v1 && \
    mv runsc containerd-shim-runsc-v1 /usr/local/bin

WORKDIR /app

# Copy pre-built rootfs from builder stage
COPY --from=rootfs-builder /build/rootfs /app/rootfs
RUN chmod 0755 /app/rootfs

RUN mkdir -p /var/run/runsc && \
    chmod -R 777 /var/run/runsc && \
    chown -R kore:kore /var/run/runsc

RUN chmod 600 /app/rootfs/etc/passwd

# Install host-side Python deps (FastAPI server)
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code (changes most often — last for cache)
COPY src/network_config/ /app/network_config/
COPY src/config_template.json src/constants.py src/logger.py src/main.py src/utils.py /app/
COPY src/rootfs_py_codetool/execute_script.py src/rootfs_py_codetool/seccomp_policy.py src/rootfs_py_codetool/utils.py /app/rootfs/
COPY runtime/ /app/rootfs/runtime/
COPY runtime_js/ /app/rootfs/runtime_js/
COPY src/logger.py /app/rootfs/gvisor_logger.py
COPY src/constants.py /app/rootfs/constants.py

RUN chown -R kore:kore /app

RUN chmod 755 /proc

USER kore

CMD ["python3", "/app/main.py"]
