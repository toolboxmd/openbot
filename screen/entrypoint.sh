#!/bin/bash
set -euo pipefail

USER_NAME="${VNC_USER:-openbot}"
PASSWORD="${VNC_PASSWORD:-openbot}"
export DISPLAY="${DISPLAY:-:1}"
export HOME="/home/${USER_NAME}"
export USER="${USER_NAME}"
export XDG_RUNTIME_DIR="/tmp/runtime-${USER_NAME}"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G ssl-cert "$USER_NAME"
else
  usermod -aG ssl-cert "$USER_NAME" || true
fi

mkdir -p /run/dbus "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
chown "$USER_NAME:$USER_NAME" "$XDG_RUNTIME_DIR"
if [ ! -e /run/dbus/pid ]; then
  dbus-daemon --system --fork || true
fi

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

exec su -s /bin/bash "$USER_NAME" -c "vncserver ${DISPLAY} -fg -geometry 1280x800 -depth 24 -websocketPort 6901 -xstartup /etc/openbot/xstartup"
