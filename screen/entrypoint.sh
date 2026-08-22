#!/bin/bash
set -euo pipefail

USER_NAME="${VNC_USER:-openbot}"
PASSWORD="${VNC_PASSWORD:-openbot}"
export DISPLAY="${DISPLAY:-:1}"
export HOME="/home/${USER_NAME}"
export USER="${USER_NAME}"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G ssl-cert "$USER_NAME"
else
  usermod -aG ssl-cert "$USER_NAME" || true
fi

mkdir -p /run/dbus
if [ ! -e /run/dbus/pid ]; then
  dbus-daemon --system --fork || true
fi

mkdir -p "$HOME/.vnc"
cp /etc/openbot/xstartup "$HOME/.vnc/xstartup"
chmod +x "$HOME/.vnc/xstartup"
chown -R "$USER_NAME:$USER_NAME" "$HOME"

# Owner password for Kasm basic auth. The box injects this; the PWA never sees it.
printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | su -s /bin/bash "$USER_NAME" -c "kasmvncpasswd -u ${USER_NAME} -w -f" \
  || printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | su -s /bin/bash "$USER_NAME" -c "kasmvncpasswd -u ${USER_NAME} -w"

# Foreground so the container stays up. Geometry matches the yaml.
if su -s /bin/bash "$USER_NAME" -c "vncserver ${DISPLAY} -fg -geometry 1280x800 -depth 24 -websocketPort 6901"; then
  exit 0
fi

su -s /bin/bash "$USER_NAME" -c "vncserver ${DISPLAY} -geometry 1280x800 -depth 24 -websocketPort 6901"
exec su -s /bin/bash "$USER_NAME" -c "tail -F ${HOME}/.vnc/*.log"
