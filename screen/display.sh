#!/bin/bash
set -euo pipefail

# Extra Kasm displays inside the one Computer container.
# usage: openbot-display start <n> | seed <n> | cookies-in <n> | cookies-out <n>

CMD="${1:-start}"
N="${2:-}"
USER_NAME="${VNC_USER:-openbot}"
HOME_DIR="/home/${USER_NAME}"
COOKIE_JAR="${COOKIE_JAR:-/computer/cookies}"

profile_dir() {
  echo "${HOME_DIR}/.config/chromium-d${1}"
}

config_dir() {
  echo "${HOME_DIR}/.config-d${1}"
}

seed_display() {
  local n="$1"
  local cfg
  cfg="$(config_dir "$n")/xfce4/xfconf/xfce-perchannel-xml"
  mkdir -p "$cfg" "$(profile_dir "$n")/Default/Network" "$HOME_DIR/.vnc"
  cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml "$cfg/xfwm4.xml"
  cp /etc/xdg/xfce4/panel/default.xml "$cfg/xfce4-panel.xml"
  cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/displays.xml "$cfg/displays.xml"
  cp /etc/openbot/xstartup "$HOME_DIR/.vnc/xstartup"
  chmod +x "$HOME_DIR/.vnc/xstartup"
  touch "$HOME_DIR/.vnc/.de-was-selected"
  chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR" || true
}

cookies_in() {
  local n="$1"
  local profile
  profile="$(profile_dir "$n")"
  mkdir -p "$profile/Default/Network"
  if [ -f "$COOKIE_JAR/Cookies" ]; then
    cp -a "$COOKIE_JAR/Cookies" "$profile/Default/Cookies" || true
  fi
  if [ -f "$COOKIE_JAR/Cookies-journal" ]; then
    cp -a "$COOKIE_JAR/Cookies-journal" "$profile/Default/Cookies-journal" || true
  fi
  if [ -d "$COOKIE_JAR/Network" ]; then
    cp -a "$COOKIE_JAR/Network/." "$profile/Default/Network/" || true
  fi
  chown -R "$USER_NAME:$USER_NAME" "$profile" || true
}

cookies_out() {
  local n="$1"
  local profile
  profile="$(profile_dir "$n")"
  mkdir -p "$COOKIE_JAR/Network"
  if [ -f "$profile/Default/Cookies" ]; then
    cp -a "$profile/Default/Cookies" "$COOKIE_JAR/Cookies" || true
  fi
  if [ -f "$profile/Default/Cookies-journal" ]; then
    cp -a "$profile/Default/Cookies-journal" "$COOKIE_JAR/Cookies-journal" || true
  fi
  if [ -f "$profile/Default/Network/Cookies" ]; then
    cp -a "$profile/Default/Network/Cookies" "$COOKIE_JAR/Network/Cookies" || true
  fi
  if [ -f "$profile/Default/Network/Cookies-journal" ]; then
    cp -a "$profile/Default/Network/Cookies-journal" "$COOKIE_JAR/Network/Cookies-journal" || true
  fi
  chmod -R a+rX "$COOKIE_JAR" || true
}

start_display() {
  local n="$1"
  if ! [[ "$n" =~ ^[2-8]$ ]]; then
    echo "openbot-display: display must be 2-8" >&2
    exit 1
  fi
  local ws_port=$((6900 + n))
  if [ -e "/tmp/.X${n}-lock" ]; then
    echo "display :${n} already up"
    return 0
  fi
  rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
  seed_display "$n"
  cookies_in "$n"
  su -s /bin/bash "$USER_NAME" -c "vncserver :${n} -geometry 1280x800 -depth 24 -websocketPort ${ws_port} -xstartup /etc/openbot/xstartup"
}

case "$CMD" in
  start)
    start_display "$N"
    ;;
  seed)
    seed_display "$N"
    ;;
  cookies-in)
    cookies_in "$N"
    ;;
  cookies-out)
    cookies_out "$N"
    ;;
  *)
    echo "usage: openbot-display start <n> | seed <n> | cookies-in <n> | cookies-out <n>" >&2
    exit 1
    ;;
esac
