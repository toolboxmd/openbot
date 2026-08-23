#!/bin/bash
set -euo pipefail

USER_NAME="${VNC_USER:-openbot}"
PASSWORD="${VNC_PASSWORD:-openbot}"
export DISPLAY="${DISPLAY:-:1}"
export HOME="/home/${USER_NAME}"
export USER="${USER_NAME}"
export XDG_RUNTIME_DIR="/tmp/runtime-${USER_NAME}"
COOKIE_JAR="${COOKIE_JAR:-/computer/cookies}"
CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-${HOME}/.config/chromium}"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G ssl-cert "$USER_NAME"
else
  usermod -aG ssl-cert "$USER_NAME" || true
fi

mkdir -p /run/dbus "$XDG_RUNTIME_DIR" "$COOKIE_JAR" "$CHROME_USER_DATA_DIR/Default/Network" /workspace
chmod 700 "$XDG_RUNTIME_DIR"
chown "$USER_NAME:$USER_NAME" "$XDG_RUNTIME_DIR"
if [ ! -e /run/dbus/pid ]; then
  dbus-daemon --system --fork || true
fi

sync_cookies_in() {
  mkdir -p "$CHROME_USER_DATA_DIR/Default/Network"
  if [ -f "$COOKIE_JAR/Cookies" ]; then
    cp -a "$COOKIE_JAR/Cookies" "$CHROME_USER_DATA_DIR/Default/Cookies" || true
  fi
  if [ -f "$COOKIE_JAR/Cookies-journal" ]; then
    cp -a "$COOKIE_JAR/Cookies-journal" "$CHROME_USER_DATA_DIR/Default/Cookies-journal" || true
  fi
  if [ -d "$COOKIE_JAR/Network" ]; then
    cp -a "$COOKIE_JAR/Network/." "$CHROME_USER_DATA_DIR/Default/Network/" || true
  fi
  chown -R "$USER_NAME:$USER_NAME" "$CHROME_USER_DATA_DIR" || true
}

sync_cookies_out() {
  mkdir -p "$COOKIE_JAR/Network"
  if [ -f "$CHROME_USER_DATA_DIR/Default/Cookies" ]; then
    cp -a "$CHROME_USER_DATA_DIR/Default/Cookies" "$COOKIE_JAR/Cookies" || true
  fi
  if [ -f "$CHROME_USER_DATA_DIR/Default/Cookies-journal" ]; then
    cp -a "$CHROME_USER_DATA_DIR/Default/Cookies-journal" "$COOKIE_JAR/Cookies-journal" || true
  fi
  if [ -f "$CHROME_USER_DATA_DIR/Default/Network/Cookies" ]; then
    cp -a "$CHROME_USER_DATA_DIR/Default/Network/Cookies" "$COOKIE_JAR/Network/Cookies" || true
  fi
  if [ -f "$CHROME_USER_DATA_DIR/Default/Network/Cookies-journal" ]; then
    cp -a "$CHROME_USER_DATA_DIR/Default/Network/Cookies-journal" "$COOKIE_JAR/Network/Cookies-journal" || true
  fi
  chmod -R a+rX "$COOKIE_JAR" || true
}

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
mkdir -p "$HOME/.vnc" "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
rm -f "$HOME/.vnc/"*.pid "$HOME/.vnc/"*.log
cp /etc/openbot/xstartup "$HOME/.vnc/xstartup"
# One workspace, no pager. Seed before XFCE writes the Debian 2x2 default.
cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml"
cp /etc/xdg/xfce4/panel/default.xml "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/displays.xml "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/displays.xml"
chmod +x "$HOME/.vnc/xstartup"
# Kasm's first-run DE picker needs a TTY. Mark it done and keep our xstartup.
touch "$HOME/.vnc/.de-was-selected"
chown -R "$USER_NAME:$USER_NAME" "$HOME"

printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | su -s /bin/bash "$USER_NAME" -c "kasmvncpasswd -u ${USER_NAME} -w"

sync_cookies_in

cleanup() {
  sync_cookies_out
  if [ -n "${VNC_PID:-}" ]; then
    kill "$VNC_PID" 2>/dev/null || true
    wait "$VNC_PID" 2>/dev/null || true
  fi
}
trap cleanup TERM INT EXIT

# Stay PID 1 so docker stop can dump the cookie jar. Do not exec.
su -s /bin/bash "$USER_NAME" -c "vncserver ${DISPLAY} -fg -geometry 1280x800 -depth 24 -websocketPort 6901 -xstartup /etc/openbot/xstartup" &
VNC_PID=$!
wait "$VNC_PID"
