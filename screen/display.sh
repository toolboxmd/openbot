#!/bin/bash
set -euo pipefail

# Extra Kasm displays inside the one Computer container.
# usage: openbot-display start <n> | seed <n> | cookies-in <n> | cookies-out <n> | pinchtab <n>

CMD="${1:-start}"
N="${2:-}"
USER_NAME="${VNC_USER:-openbot}"
HOME_DIR="${OPENBOT_SCREEN_HOME:-/home/${USER_NAME}}"
COOKIE_JAR="${COOKIE_JAR:-/computer/cookies}"

cdp_port() {
  echo $((9221 + $1))
}

pinchtab_port() {
  echo $((9866 + $1))
}

profile_dir() {
  if [ -n "${CHROME_USER_DATA_DIR:-}" ] && [ "$1" = "1" ]; then
    echo "$CHROME_USER_DATA_DIR"
  elif [ "$1" = "1" ]; then
    echo "${HOME_DIR}/.config/google-chrome"
  else
    echo "${HOME_DIR}/.config/google-chrome-d${1}"
  fi
}

config_dir() {
  echo "${HOME_DIR}/.config-d${1}"
}

seed_display() {
  local n="$1"
  local cfg panel
  cfg="$(config_dir "$n")/xfce4/xfconf/xfce-perchannel-xml"
  panel="$(config_dir "$n")/xfce4/panel"
  mkdir -p "$cfg" "$panel/launcher-1" "$panel/launcher-2" "$panel/launcher-3" \
    "$(profile_dir "$n")/Default/Network" "$HOME_DIR/.vnc"
  cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml "$cfg/xfwm4.xml"
  cp /etc/xdg/xfce4/panel/default.xml "$cfg/xfce4-panel.xml"
  cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/displays.xml "$cfg/displays.xml"
  cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml "$cfg/xfce4-desktop.xml"
  cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml "$cfg/xsettings.xml"
  cp /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml "$cfg/xfce4-session.xml"
  cp /etc/xdg/xfce4/panel/launcher-1/*.desktop "$panel/launcher-1/"
  cp /etc/xdg/xfce4/panel/launcher-2/*.desktop "$panel/launcher-2/"
  cp /etc/xdg/xfce4/panel/launcher-3/*.desktop "$panel/launcher-3/"
  cp /etc/openbot/xstartup "$HOME_DIR/.vnc/xstartup"
  chmod +x "$HOME_DIR/.vnc/xstartup"
  touch "$HOME_DIR/.vnc/.de-was-selected"
  chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR" || true
}

cookie_files() {
  echo Cookies Cookies-journal Cookies-wal Cookies-shm
}

cookies_in() {
  local n="$1"
  local profile f
  profile="$(profile_dir "$n")"
  mkdir -p "$profile/Default/Network"
  for f in $(cookie_files); do
    if [ -f "$COOKIE_JAR/$f" ]; then
      cp -a "$COOKIE_JAR/$f" "$profile/Default/$f" || true
    fi
  done
  if [ -d "$COOKIE_JAR/Network" ]; then
    cp -a "$COOKIE_JAR/Network/." "$profile/Default/Network/" || true
  fi
  chown -R "$USER_NAME:$USER_NAME" "$profile" || true
}

cookies_out() {
  local n="$1"
  local profile f
  profile="$(profile_dir "$n")"
  mkdir -p "$COOKIE_JAR/Network"
  for f in $(cookie_files); do
    if [ -f "$profile/Default/$f" ]; then
      cp -a "$profile/Default/$f" "$COOKIE_JAR/$f" || true
    fi
  done
  if [ -d "$profile/Default/Network" ]; then
    cp -a "$profile/Default/Network/." "$COOKIE_JAR/Network/" || true
  fi
  chmod -R a+rX "$COOKIE_JAR" || true
}

pinchtab_config() {
  local n="$1"
  local port token dir cfg
  port="$(pinchtab_port "$n")"
  token="${PINCHTAB_TOKEN:-}"
  dir="${HOME_DIR}/.pinchtab-d${n}"
  cfg="${dir}/config.json"
  mkdir -p "$dir"
  cat >"$cfg" <<EOF
{
  "server": {
    "port": "${port}",
    "bind": "0.0.0.0",
    "token": "${token}",
    "stateDir": "${dir}"
  },
  "browsers": { "default": "chrome" },
  "instanceDefaults": { "mode": "headed" },
  "security": {
    "allowEvaluate": false,
    "allowCookies": false,
    "allowedDomains": ["*"],
    "attach": {
      "enabled": true,
      "allowHosts": ["127.0.0.1", "localhost", "::1"],
      "allowSchemes": ["ws", "wss", "http", "https"]
    },
    "idpi": {
      "enabled": true,
      "scanContent": true,
      "wrapContent": true
    }
  },
  "autoSolver": { "enabled": false }
}
EOF
  chmod 600 "$cfg" || true
  echo "$cfg"
}

wait_cdp() {
  local port="$1"
  local i
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

pinchtab_start() {
  local n="$1"
  local cdp pt cfg log
  if [ -z "${PINCHTAB_TOKEN:-}" ] && [ -f /etc/openbot/pinchtab.token ]; then
    PINCHTAB_TOKEN="$(cat /etc/openbot/pinchtab.token)"
    export PINCHTAB_TOKEN
  fi
  if [ -z "${PINCHTAB_TOKEN:-}" ]; then
    echo "openbot-display: PINCHTAB_TOKEN missing; PinchTab stays down" >&2
    return 0
  fi
  if [ ! -x /usr/local/bin/pinchtab ]; then
    echo "openbot-display: pinchtab not installed; PinchTab stays down" >&2
    return 0
  fi
  cdp="$(cdp_port "$n")"
  pt="$(pinchtab_port "$n")"
  if ! wait_cdp "$cdp"; then
    echo "openbot-display: Chrome CDP :${cdp} did not come up; PinchTab stays down" >&2
    return 0
  fi
  cfg="$(pinchtab_config "$n")"
  log="${HOME_DIR}/.pinchtab-d${n}/bridge.log"
  mkdir -p "$(dirname "$log")"
  # New session so VNC/xstartup signals do not stop the bridge.
  # Restart if PinchTab exits; Talk fail-closed if it stays down.
  setsid sh -c "
    while true; do
      PINCHTAB_CONFIG='$cfg' PINCHTAB_TOKEN='$PINCHTAB_TOKEN' \
        /usr/local/bin/pinchtab bridge \
          --cdp-attach 'http://127.0.0.1:${cdp}' \
          --bind 0.0.0.0 \
          --port '$pt' \
          --browser chrome
      sleep 1
    done
  " >>"$log" 2>&1 < /dev/null &
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
  export PINCHTAB_TOKEN
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
  pinchtab)
    pinchtab_start "$N"
    ;;
  *)
    echo "usage: openbot-display start <n> | seed <n> | cookies-in <n> | cookies-out <n> | pinchtab <n>" >&2
    exit 1
    ;;
esac
