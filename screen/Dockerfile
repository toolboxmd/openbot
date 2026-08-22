FROM debian:bookworm-slim
ARG TARGETARCH
ARG KASM_VERSION=1.5.0
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DISPLAY=:1 \
    VNC_USER=openbot \
    VNC_PASSWORD=openbot

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dbus \
      dbus-x11 \
      fonts-dejavu-core \
      procps \
      ssl-cert \
      thunar \
      wget \
      x11-xserver-utils \
      xfce4-panel \
      xfce4-session \
      xfce4-settings \
      xfce4-terminal \
      xfdesktop4 \
      xfwm4 \
      chromium \
    && rm -rf /var/lib/apt/lists/*

RUN arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64|x86_64) deb_arch=amd64 ;; \
      arm64|aarch64) deb_arch=arm64 ;; \
      *) deb_arch=amd64 ;; \
    esac; \
    wget -q "https://github.com/kasmtech/KasmVNC/releases/download/v${KASM_VERSION}/kasmvncserver_bookworm_${KASM_VERSION}_${deb_arch}.deb" -O /tmp/kasmvnc.deb \
    && apt-get update \
    && apt-get install -y /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/*

COPY kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml
COPY xstartup /etc/openbot/xstartup
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /etc/openbot/xstartup

EXPOSE 6901
CMD ["/entrypoint.sh"]
