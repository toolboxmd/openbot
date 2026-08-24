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
COPY display.sh /usr/local/bin/openbot-display
COPY xfce/xfwm4.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml
COPY xfce/panel-default.xml /etc/xdg/xfce4/panel/default.xml
COPY xfce/displays.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/displays.xml
COPY www/openbot.css /usr/share/kasmvnc/www/openbot.css
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /etc/openbot/xstartup /usr/local/bin/openbot-display \
    && sed -i 's|</head>|<link rel="stylesheet" href="openbot.css"></head>|' \
         /usr/share/kasmvnc/www/index.html \
         /usr/share/kasmvnc/www/vnc.html \
         /usr/share/kasmvnc/www/screen.html

EXPOSE 6901 6902 6903 6904 6905 6906 6907 6908
CMD ["/entrypoint.sh"]
