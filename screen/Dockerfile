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
      gnupg \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome (not Debian Chromium). Official Linux build is amd64-only.
# Retry Google apt, then the official .deb. Never fall back to Chromium.
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in amd64|x86_64) ;; \
      *) echo "google-chrome-stable is amd64-only (got ${arch}); not installing Chromium" >&2; exit 1 ;; \
    esac; \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg; \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list; \
    ok=0; \
    for i in 1 2 3 4 5; do \
      if apt-get update && apt-get install -y google-chrome-stable; then ok=1; break; fi; \
      echo "google-chrome-stable apt attempt ${i} failed; retrying"; \
      sleep $((i * 3)); \
    done; \
    if [ "$ok" != 1 ]; then \
      echo "apt repo failed; trying official .deb"; \
      for i in 1 2 3; do \
        if wget -q --tries=3 --timeout=60 -O /tmp/google-chrome.deb \
             https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
           && apt-get update \
           && apt-get install -y /tmp/google-chrome.deb; then \
          ok=1; rm -f /tmp/google-chrome.deb; break; \
        fi; \
        rm -f /tmp/google-chrome.deb; \
        echo "chrome .deb attempt ${i} failed; retrying"; \
        sleep $((i * 3)); \
      done; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    if [ "$ok" != 1 ]; then \
      echo "failed to install google-chrome-stable after retries; Chromium is not a fallback" >&2; \
      exit 1; \
    fi; \
    command -v google-chrome-stable; \
    google-chrome-stable --version

# linux-amd64 PinchTab for the in-Screen bridge. Talk MCP runs on the host.
ARG PINCHTAB_VERSION=v0.15.2
RUN set -eux; \
    curl -fsSL -o /usr/local/bin/pinchtab \
      "https://github.com/pinchtab/pinchtab/releases/download/${PINCHTAB_VERSION}/pinchtab-linux-amd64"; \
    chmod +x /usr/local/bin/pinchtab; \
    pinchtab --version

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
COPY xfce/xfce4-desktop.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
COPY xfce/xsettings.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml
COPY xfce/xfce4-session.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml
COPY xfce/launcher-1 /etc/xdg/xfce4/panel/launcher-1
COPY xfce/launcher-2 /etc/xdg/xfce4/panel/launcher-2
COPY xfce/launcher-3 /etc/xdg/xfce4/panel/launcher-3
COPY xfce/xfdesktop.desktop /etc/xdg/autostart/xfdesktop.desktop
COPY www/openbot.css /usr/share/kasmvnc/www/openbot.css
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /etc/openbot/xstartup /usr/local/bin/openbot-display \
    && sed -i 's|</head>|<link rel="stylesheet" href="openbot.css"></head>|' \
         /usr/share/kasmvnc/www/index.html \
         /usr/share/kasmvnc/www/vnc.html \
         /usr/share/kasmvnc/www/screen.html
RUN apt-get update && apt-get install -y --no-install-recommends \
      adwaita-icon-theme gnome-themes-extra \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 6901 6902 6903 6904 6905 6906 6907 6908
EXPOSE 9867 9868 9869 9870 9871 9872 9873 9874
CMD ["/entrypoint.sh"]
