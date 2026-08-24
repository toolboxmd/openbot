#!/bin/bash
set -euo pipefail

USER_NAME="${VNC_USER:-openbot}"
PASSWORD="${VNC_PASSWORD:-openbot}"
export DISPLAY="${DISPLAY:-:1}"
export HOME="/home/${USER_NAME}"
export USER="${USER_NAME}"
export XDG_RUNTIME_DIR="/tmp/runtime-${USER_NAME}"
COOKIE_JAR="${COOKIE_JAR:-/computer/cookies}"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G ssl-cert "$USER_NAME"
else
  usermod -aG ssl-cert "$USER_NAME" || true
fi

mkdir -p /run/dbus "$XDG_RUNTIME_DIR" "$COOKIE_JAR" /workspace
chmod 700 "$XDG_RUNTIME_DIR"
chown "$USER_NAME:$USER_NAME" "$XDG_RUNTIME_DIR"
if [ ! -e /run/dbus/pid ]; then
  dbus-daemon --system --fork || true
fi

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
mkdir -p "$HOME/.vnc"
rm -f "$HOME/.vnc/"*.pid "$HOME/.vnc/"*.log
cp /etc/openbot/xstartup "$HOME/.vnc/xstartup"
chmod +x "$HOME/.vnc/xstartup"
touch "$HOME/.vnc/.de-was-selected"
chown -R "$USER_NAME:$USER_NAME" "$HOME"

# Owner + read, no write: view-only until Talk zooms and calls /api/update_user?write=true.
printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | su -s /bin/bash "$USER_NAME" -c "kasmvncpasswd -u ${USER_NAME} -o -r"

/usr/local/bin/openbot-display seed 1
/usr/local/bin/openbot-display cookies-in 1

cleanup() {
  /usr/local/bin/openbot-display cookies-out 1 || true
  if [ -n "${VNC_PID:-}" ]; then
    kill "$VNC_PID" 2>/dev/null || true
    wait "$VNC_PID" 2>/dev/null || true
  fi
}
trap cleanup TERM INT EXIT

# Stay PID 1 so docker stop can dump the cookie jar. Display :1 stays lit.
su -s /bin/bash "$USER_NAME" -c "vncserver ${DISPLAY} -fg -geometry 1280x800 -depth 24 -websocketPort 6901 -xstartup /etc/openbot/xstartup" &
VNC_PID=$!
wait "$VNC_PID"
