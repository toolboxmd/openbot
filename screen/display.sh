#!/bin/bash
set -euo pipefail

# Extra Kasm displays inside the one Computer container.
# usage: openbot-display start <n> | stop <n> | seed <n> | cookies-in <n> | cookies-out <n> | pinchtab <n>

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

# Chrome 115+ stores cookies in Default/Network/Cookies. Default/Cookies is leftover.
copy_cookie_files() {
  local src="$1"
  local dest="$2"
  local f
  mkdir -p "$dest"
  for f in $(cookie_files); do
    if [ -f "$src/$f" ]; then
      cp -a "$src/$f" "$dest/$f" || true
    fi
  done
}

promote_legacy_cookies() {
  local dest="$1"
  if [ ! -f "$dest/Network/Cookies" ] && [ -f "$dest/Cookies" ]; then
    mkdir -p "$dest/Network"
    copy_cookie_files "$dest" "$dest/Network"
  fi
}

checkpoint_cookie_db() {
  local db="$1"
  if [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" "PRAGMA wal_checkpoint(FULL);" >/dev/null 2>&1 || true
  fi
}

# Chrome encrypts cookie values with os_crypt in Local State. Copy that with the jar.
cookies_in() {
  local n="$1"
  local profile
  profile="$(profile_dir "$n")"
  mkdir -p "$profile/Default/Network"
  if [ -f "$COOKIE_JAR/Local State" ]; then
    cp -a "$COOKIE_JAR/Local State" "$profile/Local State" || true
  fi
  copy_cookie_files "$COOKIE_JAR/Network" "$profile/Default/Network"
  copy_cookie_files "$COOKIE_JAR" "$profile/Default"
  if [ ! -f "$profile/Default/Network/Cookies" ] && [ -f "$COOKIE_JAR/Cookies" ]; then
    copy_cookie_files "$COOKIE_JAR" "$profile/Default/Network"
  fi
  chown -R "$USER_NAME:$USER_NAME" "$profile" || true
}

cookies_out() {
  local n="$1"
  local profile
  profile="$(profile_dir "$n")"
  mkdir -p "$COOKIE_JAR/Network"
  checkpoint_cookie_db "$profile/Default/Network/Cookies"
  checkpoint_cookie_db "$profile/Default/Cookies"
  if [ -f "$profile/Local State" ]; then
    cp -a "$profile/Local State" "$COOKIE_JAR/Local State" || true
  fi
  copy_cookie_files "$profile/Default/Network" "$COOKIE_JAR/Network"
  copy_cookie_files "$profile/Default" "$COOKIE_JAR"
  promote_legacy_cookies "$COOKIE_JAR"
  chmod -R a+rX "$COOKIE_JAR" || true
}

pinchtab_config() {
  local n="$1"
  local port token dir cfg profile base name cdp
  port="$(pinchtab_port "$n")"
  cdp="$(cdp_port "$n")"
  token="${PINCHTAB_TOKEN:-}"
  dir="${HOME_DIR}/.pinchtab-d${n}"
  cfg="${dir}/config.json"
  profile="$(profile_dir "$n")"
  base="$(dirname "$profile")"
  name="$(basename "$profile")"
  mkdir -p "$dir" "$profile"
  cat >"$cfg" <<EOF
{
  "server": {
    "port": "${port}",
    "bind": "0.0.0.0",
    "token": "${token}",
    "stateDir": "${dir}"
  },
  "browsers": { "default": "chrome" },
  "browser": {
    "binary": "/usr/bin/google-chrome-stable",
    "remoteDebuggingPort": ${cdp}
  },
  "profiles": {
    "baseDir": "${base}",
    "defaultProfile": "${name}"
  },
  "instanceDefaults": {
    "mode": "headed",
    "captureAllowActivation": true
  },
  "security": {
    "allowEvaluate": false,
    "allowCookies": false,
    "allowedDomains": ["*"],
    "attach": {
      "enabled": false,
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

wait_bridge() {
  local port="$1"
  local i
  for i in $(seq 1 60); do
    if curl -fsS -H "Authorization: Bearer ${PINCHTAB_TOKEN}" \
         "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Launch headed Chrome now. Bridge stays up with no window until this or the first navigate.
ensure_chrome() {
  local port="$1"
  curl -fsS -X POST \
    -H "Authorization: Bearer ${PINCHTAB_TOKEN}" \
    -H "content-type: application/json" \
    "http://127.0.0.1:${port}/ensure-browser" >/dev/null 2>&1
}

pinchtab_start() {
  local n="$1"
  local pt cfg log
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
  pt="$(pinchtab_port "$n")"
  cfg="$(pinchtab_config "$n")"
  log="${HOME_DIR}/.pinchtab-d${n}/bridge.log"
  mkdir -p "$(dirname "$log")"
  # Bridge launches headed Chrome. CDP attach injects [PinchTab :port] into document.title; this path does not attach.
  # New session so VNC/xstartup signals do not stop the bridge.
  setsid sh -c "
    export DISPLAY=:${n}
    export CHROME_USER_DATA_DIR='$(profile_dir "$n")'
    while true; do
      PINCHTAB_CONFIG='$cfg' PINCHTAB_TOKEN='$PINCHTAB_TOKEN' \
        /usr/local/bin/pinchtab bridge \
          --bind 0.0.0.0 \
          --port '$pt' \
          --browser chrome
      sleep 1
    done
  " >>"$log" 2>&1 < /dev/null &
  if ! wait_bridge "$pt"; then
    echo "openbot-display: PinchTab bridge :${pt} did not become healthy" >&2
    return 0
  fi
  if ! ensure_chrome "$pt"; then
    echo "openbot-display: PinchTab did not launch headed Chrome on :${pt}" >&2
  fi
}

stop_chrome() {
  local n="$1"
  local profile
  profile="$(profile_dir "$n")"
  # Trailing space so display 1 does not match google-chrome-d2.
  # Pattern must not start with --; pgrep/pkill treat that as flags.
  local pat="user-data-dir=${profile} "
  pkill -f -- "$pat" 2>/dev/null || true
  local i
  for i in $(seq 1 15); do
    if ! pgrep -af -- "$pat" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  pkill -9 -f -- "$pat" 2>/dev/null || true
  sleep 1
}

stop_display() {
  local n="$1"
  if ! [[ "$n" =~ ^[1-8]$ ]]; then
    echo "openbot-display: display must be 1-8" >&2
    exit 1
  fi
  stop_chrome "$n"
  cookies_out "$n"
  if [[ "$n" =~ ^[2-8]$ ]]; then
    su -s /bin/bash "$USER_NAME" -c "vncserver -kill :${n}" 2>/dev/null || true
    rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
  fi
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
  stop)
    stop_display "$N"
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
    echo "usage: openbot-display start <n> | stop <n> | seed <n> | cookies-in <n> | cookies-out <n> | pinchtab <n>" >&2
    exit 1
    ;;
esac
