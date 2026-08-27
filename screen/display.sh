#!/bin/bash
set -euo pipefail

# Extra Kasm displays inside the one Computer container.
# usage: openbot-display start <n> | stop <n> | seed <n> | cookies-in <n> | cookies-out <n> | pinchtab <n>

CMD="${1:-start}"
N="${2:-}"
USER_NAME="${VNC_USER:-openbot}"
HOME_DIR="${OPENBOT_SCREEN_HOME:-/home/${USER_NAME}}"
COOKIE_JAR="${COOKIE_JAR:-/computer/cookies}"
PINCHTAB_BIN="${OPENBOT_PINCHTAB_BIN:-/usr/local/bin/pinchtab}"
SETSID_BIN="${OPENBOT_SETSID_BIN:-setsid}"
SCRIPT_PATH="$0"
PINCHTAB_CONNECT_TIMEOUT_SEC="${OPENBOT_PINCHTAB_CONNECT_TIMEOUT_SEC:-1}"
PINCHTAB_BODY_TIMEOUT_SEC="${OPENBOT_PINCHTAB_BODY_TIMEOUT_SEC:-2}"
PINCHTAB_REQUEST_TIMEOUT_SEC="${OPENBOT_PINCHTAB_REQUEST_TIMEOUT_SEC:-3}"
PINCHTAB_START_TIMEOUT_SEC="${OPENBOT_PINCHTAB_START_TIMEOUT_SEC:-60}"

cdp_port() {
  echo $((${OPENBOT_CDP_PORT_BASE:-9221} + $1))
}

pinchtab_port() {
  echo $((${OPENBOT_PINCHTAB_PORT_BASE:-9866} + $1))
}

pinchtab_dir() {
  echo "${HOME_DIR}/.pinchtab-d${1}"
}

pinchtab_owner_file() {
  echo "$(pinchtab_dir "$1")/bridge-owner.json"
}

pinchtab_lock_dir() {
  echo "$(pinchtab_dir "$1")/startup.lock"
}

process_start_id() {
  local pid="$1"
  if [ -r "/proc/${pid}/stat" ]; then
    awk '{print $22}' "/proc/${pid}/stat" 2>/dev/null || true
    return
  fi
  ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//' || true
}

process_matches() {
  local pid="$1"
  local expected_start="$2"
  [ -n "$pid" ] && [ -n "$expected_start" ] && kill -0 "$pid" 2>/dev/null \
    && [ "$(process_start_id "$pid")" = "$expected_start" ]
}

pinchtab_lock_valid() {
  local n="$1"
  local lock pid start
  lock="$(pinchtab_lock_dir "$n")"
  [ -d "$lock" ] || return 1
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  start="$(cat "$lock/start" 2>/dev/null || true)"
  process_matches "$pid" "$start"
}

acquire_pinchtab_lock() {
  local n="$1"
  local lock deadline invalid_seen
  lock="$(pinchtab_lock_dir "$n")"
  mkdir -p "$(dirname "$lock")"
  deadline=$((SECONDS + PINCHTAB_START_TIMEOUT_SEC + PINCHTAB_REQUEST_TIMEOUT_SEC + 5))
  invalid_seen=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    if mkdir "$lock" 2>/dev/null; then
      printf '%s\n' "$$" >"$lock/pid"
      printf '%s\n' "$(process_start_id "$$")" >"$lock/start"
      return 0
    fi
    if pinchtab_lock_valid "$n"; then
      invalid_seen=0
    else
      invalid_seen=$((invalid_seen + 1))
      if [ "$invalid_seen" -ge 10 ]; then
        echo "openbot-display: removing stale PinchTab startup lock for display :${n}" >&2
        rm -f "$lock/pid" "$lock/start"
        rmdir "$lock" 2>/dev/null || true
        invalid_seen=0
        continue
      fi
    fi
    sleep 0.05
  done
  return 1
}

release_pinchtab_lock() {
  local n="$1"
  local lock pid start
  lock="$(pinchtab_lock_dir "$n")"
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  start="$(cat "$lock/start" 2>/dev/null || true)"
  if [ "$pid" = "$$" ] && [ "$start" = "$(process_start_id "$$")" ]; then
    rm -f "$lock/pid" "$lock/start"
    rmdir "$lock" 2>/dev/null || true
  fi
}

owner_field() {
  local file="$1"
  local field="$2"
  jq -r --arg field "$field" '.[$field] // empty' "$file" 2>/dev/null || true
}

write_pinchtab_owner() {
  local n="$1"
  local port="$2"
  local config="$3"
  local supervisor_pid="$4"
  local child_pid="$5"
  local file tmp
  file="$(pinchtab_owner_file "$n")"
  tmp="${file}.tmp.$$"
  jq -n \
    --argjson schema 1 \
    --argjson display "$n" \
    --argjson port "$port" \
    --argjson supervisorPid "$supervisor_pid" \
    --arg supervisorStart "$(process_start_id "$supervisor_pid")" \
    --argjson childPid "$child_pid" \
    --arg childStart "$(process_start_id "$child_pid")" \
    --arg binary "$PINCHTAB_BIN" \
    --arg config "$config" \
    '{schema:$schema,display:$display,port:$port,supervisorPid:$supervisorPid,supervisorStart:$supervisorStart,childPid:$childPid,childStart:$childStart,binary:$binary,config:$config}' \
    >"$tmp"
  chmod 600 "$tmp" || true
  mv -f "$tmp" "$file"
}

pinchtab_owner_valid() {
  local n="$1"
  local port="$2"
  local file supervisor_pid supervisor_start child_pid child_start
  file="$(pinchtab_owner_file "$n")"
  [ -f "$file" ] || return 1
  [ "$(owner_field "$file" schema)" = "1" ] || return 1
  [ "$(owner_field "$file" display)" = "$n" ] || return 1
  [ "$(owner_field "$file" port)" = "$port" ] || return 1
  [ "$(owner_field "$file" binary)" = "$PINCHTAB_BIN" ] || return 1
  supervisor_pid="$(owner_field "$file" supervisorPid)"
  supervisor_start="$(owner_field "$file" supervisorStart)"
  child_pid="$(owner_field "$file" childPid)"
  child_start="$(owner_field "$file" childStart)"
  process_matches "$supervisor_pid" "$supervisor_start" \
    && process_matches "$child_pid" "$child_start"
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
  local port token dir cfg tmp profile base name cdp
  port="$(pinchtab_port "$n")"
  cdp="$(cdp_port "$n")"
  token="${PINCHTAB_TOKEN:-}"
  dir="$(pinchtab_dir "$n")"
  cfg="${dir}/config.json"
  profile="$(profile_dir "$n")"
  base="$(dirname "$profile")"
  name="$(basename "$profile")"
  mkdir -p "$dir" "$profile"
  tmp="${cfg}.tmp.$$"
  jq -n \
    --arg port "$port" \
    --arg token "$token" \
    --arg stateDir "$dir" \
    --argjson remoteDebuggingPort "$cdp" \
    --arg baseDir "$base" \
    --arg defaultProfile "$name" \
    '{
      server: {port:$port,bind:"0.0.0.0",token:$token,stateDir:$stateDir},
      browsers: {default:"chrome"},
      browser: {binary:"/usr/bin/google-chrome-stable",remoteDebuggingPort:$remoteDebuggingPort},
      profiles: {baseDir:$baseDir,defaultProfile:$defaultProfile},
      instanceDefaults: {mode:"headed",captureAllowActivation:true},
      security: {
        allowEvaluate:false,
        allowCookies:false,
        allowedDomains:["*"],
        attach:{
          enabled:false,
          allowHosts:["127.0.0.1","localhost","::1"],
          allowSchemes:["ws","wss","http","https"]
        },
        idpi:{enabled:true,scanContent:true,wrapContent:true}
      },
      autoSolver:{enabled:false}
    }' >"$tmp"
  chmod 600 "$tmp" || true
  mv -f "$tmp" "$cfg"
  echo "$cfg"
}

pinchtab_curl() {
  local total_timeout="$1"
  shift
  curl -fsS \
    --connect-timeout "$PINCHTAB_CONNECT_TIMEOUT_SEC" \
    --max-time "$total_timeout" \
    --speed-limit 1 \
    --speed-time "$PINCHTAB_BODY_TIMEOUT_SEC" \
    "$@"
}

pinchtab_deadline_summary() {
  printf 'startup=%ss connect=%ss header/total=%ss body-inactivity=%ss' \
    "$PINCHTAB_START_TIMEOUT_SEC" \
    "$PINCHTAB_CONNECT_TIMEOUT_SEC" \
    "$PINCHTAB_REQUEST_TIMEOUT_SEC" \
    "$PINCHTAB_BODY_TIMEOUT_SEC"
}

pinchtab_health() {
  local port="$1"
  local total_timeout="${2:-$PINCHTAB_REQUEST_TIMEOUT_SEC}"
  pinchtab_curl "$total_timeout" \
    -H "Authorization: Bearer ${PINCHTAB_TOKEN}" \
    "http://127.0.0.1:${port}/health" >/dev/null 2>&1
}

wait_bridge() {
  local port="$1"
  local deadline remaining request_timeout health_seen
  deadline=$((SECONDS + PINCHTAB_START_TIMEOUT_SEC))
  health_seen=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    request_timeout="$PINCHTAB_REQUEST_TIMEOUT_SEC"
    if [ "$remaining" -lt "$request_timeout" ]; then
      request_timeout="$remaining"
    fi
    if pinchtab_health "$port" "$request_timeout"; then
      health_seen=1
      remaining=$((deadline - SECONDS))
      if [ "$remaining" -gt 0 ]; then
        request_timeout="$PINCHTAB_REQUEST_TIMEOUT_SEC"
        if [ "$remaining" -lt "$request_timeout" ]; then
          request_timeout="$remaining"
        fi
        if ensure_chrome "$port" "$request_timeout"; then
          return 0
        fi
      fi
    fi
    if [ "$SECONDS" -lt "$deadline" ]; then sleep 1; fi
  done
  if [ "$health_seen" = "1" ]; then return 2; fi
  return 1
}

# Launch headed Chrome now. Bridge stays up with no window until this or the first navigate.
ensure_chrome() {
  local port="$1"
  local total_timeout="${2:-$PINCHTAB_REQUEST_TIMEOUT_SEC}"
  pinchtab_curl "$total_timeout" -X POST \
    -H "Authorization: Bearer ${PINCHTAB_TOKEN}" \
    -H "content-type: application/json" \
    "http://127.0.0.1:${port}/ensure-browser" >/dev/null 2>&1
}

bridge_ready() {
  local port="$1"
  pinchtab_health "$port" \
    && ensure_chrome "$port"
}

pinchtab_port_in_use() {
  local port="$1"
  local connected
  if command -v timeout >/dev/null 2>&1; then
    timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}" >/dev/null 2>&1
    return
  fi
  connected="$(curl -sS --connect-timeout 1 --max-time 1 -o /dev/null \
    -w '%{time_connect}' "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  [ -n "$connected" ] && [ "$connected" != "0.000000" ]
}

pinchtab_stop_locked() {
  local n="$1"
  local file supervisor_pid supervisor_start child_pid child_start i
  file="$(pinchtab_owner_file "$n")"
  [ -f "$file" ] || return 0
  supervisor_pid="$(owner_field "$file" supervisorPid)"
  supervisor_start="$(owner_field "$file" supervisorStart)"
  child_pid="$(owner_field "$file" childPid)"
  child_start="$(owner_field "$file" childStart)"

  if process_matches "$supervisor_pid" "$supervisor_start"; then
    kill "$supervisor_pid" 2>/dev/null || true
  fi
  for i in $(seq 1 40); do
    if ! process_matches "$supervisor_pid" "$supervisor_start" \
      && ! process_matches "$child_pid" "$child_start"; then
      rm -f "$file"
      return 0
    fi
    sleep 0.1
  done
  if process_matches "$child_pid" "$child_start"; then
    kill "$child_pid" 2>/dev/null || true
  fi
  if process_matches "$supervisor_pid" "$supervisor_start"; then
    kill -9 "$supervisor_pid" 2>/dev/null || true
  fi
  for i in $(seq 1 20); do
    if ! process_matches "$child_pid" "$child_start" \
      && ! process_matches "$supervisor_pid" "$supervisor_start"; then
      break
    fi
    sleep 0.1
  done
  if process_matches "$child_pid" "$child_start"; then
    kill -9 "$child_pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

pinchtab_stop() {
  local n="$1"
  local result port
  if ! acquire_pinchtab_lock "$n"; then
    echo "openbot-display: timed out waiting for PinchTab lifecycle lock on :${n}" >&2
    return 1
  fi
  if pinchtab_stop_locked "$n"; then result=0; else result=$?; fi
  port="$(pinchtab_port "$n")"
  if pinchtab_port_in_use "$port"; then
    echo "openbot-display: PinchTab port ${port} remains occupied without a valid owner; refusing to kill an unowned process" >&2
    result=1
  fi
  release_pinchtab_lock "$n"
  return "$result"
}

pinchtab_supervise() {
  local n="$1"
  local port config child_pid child_start lock expected_pid expected_start lock_pid lock_start
  lock="$(pinchtab_lock_dir "$n")"
  expected_pid="${OPENBOT_PINCHTAB_LOCK_PID:-}"
  expected_start="${OPENBOT_PINCHTAB_LOCK_START:-}"
  lock_pid="$(cat "$lock/pid" 2>/dev/null || true)"
  lock_start="$(cat "$lock/start" 2>/dev/null || true)"
  if [ -z "$expected_pid" ] || [ -z "$expected_start" ] \
    || [ "$lock_pid" != "$expected_pid" ] || [ "$lock_start" != "$expected_start" ] \
    || ! process_matches "$expected_pid" "$expected_start"; then
    echo "openbot-display: PinchTab supervisor is not authorized by the lifecycle lock on :${n}" >&2
    return 1
  fi
  port="$(pinchtab_port "$n")"
  config="$(pinchtab_config "$n")"
  child_pid=""
  child_start=""

  cleanup_pinchtab_supervisor() {
    trap - TERM INT EXIT
    if [ -n "$child_pid" ] && process_matches "$child_pid" "$child_start"; then
      kill "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
    fi
    local owner
    owner="$(pinchtab_owner_file "$n")"
    if [ "$(owner_field "$owner" supervisorPid)" = "$$" ]; then
      rm -f "$owner"
    fi
  }
  trap 'exit 0' TERM INT
  trap cleanup_pinchtab_supervisor EXIT

  while true; do
    DISPLAY=":${n}" \
      CHROME_USER_DATA_DIR="$(profile_dir "$n")" \
      PINCHTAB_CONFIG="$config" \
      PINCHTAB_TOKEN="$PINCHTAB_TOKEN" \
      "$PINCHTAB_BIN" bridge \
        --bind 0.0.0.0 \
        --port "$port" \
        --browser chrome &
    child_pid=$!
    child_start="$(process_start_id "$child_pid")"
    write_pinchtab_owner "$n" "$port" "$config" "$$" "$child_pid"
    if wait "$child_pid"; then
      :
    fi
    child_pid=""
    child_start=""
    sleep 1
  done
}

pinchtab_start_locked() {
  local n="$1"
  local pt cfg log owner i ready_status
  pt="$(pinchtab_port "$n")"
  cfg="$(pinchtab_config "$n")"
  log="$(pinchtab_dir "$n")/bridge.log"
  owner="$(pinchtab_owner_file "$n")"
  mkdir -p "$(dirname "$log")"
  if pinchtab_owner_valid "$n" "$pt" && bridge_ready "$pt"; then
    echo "openbot-display: PinchTab bridge :${pt} already supervised"
    return 0
  fi
  pinchtab_stop_locked "$n"
  if pinchtab_port_in_use "$pt"; then
    echo "openbot-display: PinchTab port ${pt} is already in use without a valid owner" >&2
    return 1
  fi

  # One new session owns one supervisor and child for this display.
  OPENBOT_PINCHTAB_LOCK_PID="$$" \
    OPENBOT_PINCHTAB_LOCK_START="$(process_start_id "$$")" \
    "$SETSID_BIN" bash "$SCRIPT_PATH" pinchtab-supervise "$n" >>"$log" 2>&1 < /dev/null &
  for i in $(seq 1 50); do
    if pinchtab_owner_valid "$n" "$pt"; then
      break
    fi
    sleep 0.1
  done
  if ! pinchtab_owner_valid "$n" "$pt"; then
    echo "openbot-display: PinchTab supervisor did not publish owner ${owner}" >&2
    pinchtab_stop_locked "$n"
    return 1
  fi
  if wait_bridge "$pt"; then
    return 0
  else
    ready_status=$?
    if [ "$ready_status" = "2" ]; then
      echo "openbot-display: PinchTab did not launch headed Chrome on :${pt} within $(pinchtab_deadline_summary)" >&2
    else
      echo "openbot-display: PinchTab bridge :${pt} did not become healthy within $(pinchtab_deadline_summary)" >&2
    fi
    pinchtab_stop_locked "$n"
    return 1
  fi
}

pinchtab_start() {
  local n="$1"
  local result
  if [ -z "${PINCHTAB_TOKEN:-}" ] && [ -f /etc/openbot/pinchtab.token ]; then
    PINCHTAB_TOKEN="$(cat /etc/openbot/pinchtab.token)"
    export PINCHTAB_TOKEN
  fi
  if [ -z "${PINCHTAB_TOKEN:-}" ]; then
    echo "openbot-display: PINCHTAB_TOKEN missing; PinchTab stays down" >&2
    return 1
  fi
  if [ ! -x "$PINCHTAB_BIN" ]; then
    echo "openbot-display: pinchtab not installed; PinchTab stays down" >&2
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "openbot-display: jq is required for PinchTab state" >&2
    return 1
  fi
  if ! acquire_pinchtab_lock "$n"; then
    echo "openbot-display: timed out waiting for PinchTab lifecycle lock on :${n}" >&2
    return 1
  fi
  if pinchtab_start_locked "$n"; then result=0; else result=$?; fi
  release_pinchtab_lock "$n"
  return "$result"
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
  local result=0
  if ! [[ "$n" =~ ^[1-8]$ ]]; then
    echo "openbot-display: display must be 1-8" >&2
    exit 1
  fi
  if ! pinchtab_stop "$n"; then result=1; fi
  if ! stop_chrome "$n"; then
    echo "openbot-display: failed to stop Chrome for display :${n}" >&2
    result=1
  fi
  if ! cookies_out "$n"; then
    echo "openbot-display: failed to copy cookies for display :${n}" >&2
    result=1
  fi
  if [[ "$n" =~ ^[2-8]$ ]]; then
    su -s /bin/bash "$USER_NAME" -c "vncserver -kill :${n}" 2>/dev/null || true
    if ! rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"; then
      echo "openbot-display: failed to remove X state for display :${n}" >&2
      result=1
    fi
  fi
  return "$result"
}

start_display() {
  local n="$1"
  if ! [[ "$n" =~ ^[2-8]$ ]]; then
    echo "openbot-display: display must be 2-8" >&2
    exit 1
  fi
  local ws_port=$((6900 + n))
  if [ -e "/tmp/.X${n}-lock" ]; then
    local x_pid
    x_pid="$(awk 'NR == 1 { print $1 }' "/tmp/.X${n}-lock" 2>/dev/null || true)"
    if [[ "$x_pid" =~ ^[0-9]+$ ]] && kill -0 "$x_pid" 2>/dev/null; then
      echo "display :${n} already up"
      if [ -n "${PINCHTAB_TOKEN:-}" ]; then
        pinchtab_start "$n"
      fi
      return 0
    fi
    echo "openbot-display: removing stale X lock for display :${n}" >&2
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
  pinchtab-supervise)
    pinchtab_supervise "$N"
    ;;
  *)
    echo "usage: openbot-display start <n> | stop <n> | seed <n> | cookies-in <n> | cookies-out <n> | pinchtab <n>" >&2
    exit 1
    ;;
esac
