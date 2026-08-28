#!/bin/bash
set +x
set -euo pipefail
umask 077

# Extra Kasm displays inside the one Computer container.
# usage: openbot-display start <n> | stop <n> | discard <n> | seed <n> | cookies-in <n> | cookies-out <n> | cookies-clear <n> | pinchtab <n>

CMD="${1:-start}"
N="${2:-}"
USER_NAME="${VNC_USER:-openbot}"
HOME_DIR="${OPENBOT_SCREEN_HOME:-/home/${USER_NAME}}"
COOKIE_JAR="${COOKIE_JAR:-/computer/cookies}"
PINCHTAB_BIN="${OPENBOT_PINCHTAB_BIN:-/usr/local/bin/pinchtab}"
PINCHTAB_TOKEN_FILE="${OPENBOT_PINCHTAB_TOKEN_FILE:-/etc/openbot/secrets/pinchtab.token}"
SETSID_BIN="${OPENBOT_SETSID_BIN:-setsid}"
SCRIPT_PATH="$0"
PINCHTAB_CONNECT_TIMEOUT_SEC="${OPENBOT_PINCHTAB_CONNECT_TIMEOUT_SEC:-1}"
PINCHTAB_BODY_TIMEOUT_SEC="${OPENBOT_PINCHTAB_BODY_TIMEOUT_SEC:-2}"
PINCHTAB_REQUEST_TIMEOUT_SEC="${OPENBOT_PINCHTAB_REQUEST_TIMEOUT_SEC:-3}"
PINCHTAB_START_TIMEOUT_SEC="${OPENBOT_PINCHTAB_START_TIMEOUT_SEC:-60}"
X_LOCK_DIR="${OPENBOT_X_LOCK_DIR:-/tmp}"
X_SOCKET_DIR="${OPENBOT_X_SOCKET_DIR:-/tmp/.X11-unix}"

case "$CMD" in
  start)
    if ! [[ "$N" =~ ^[2-8]$ ]]; then
      echo "openbot-display: display must be 2-8" >&2
      exit 1
    fi
    ;;
  discard)
    if ! [[ "$N" =~ ^[2-8]$ ]]; then
      echo "openbot-display: display must be 2-8" >&2
      exit 1
    fi
    ;;
  stop|seed|cookies-in|cookies-out|cookies-clear|pinchtab|pinchtab-supervise)
    if ! [[ "$N" =~ ^[1-8]$ ]]; then
      echo "openbot-display: display must be 1-8" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: openbot-display start <n> | stop <n> | discard <n> | seed <n> | cookies-in <n> | cookies-out <n> | cookies-clear <n> | pinchtab <n>" >&2
    exit 1
    ;;
esac

cdp_port() {
  echo $((${OPENBOT_CDP_PORT_BASE:-9221} + $1))
}

pinchtab_port() {
  echo $((${OPENBOT_PINCHTAB_PORT_BASE:-9866} + $1))
}

pinchtab_dir() {
  echo "${HOME_DIR}/.pinchtab-d${1}"
}

pinchtab_authorization_file() {
  echo "$(pinchtab_dir "$1")/authorization.header"
}

private_directory_target_safe() {
  local target="$1"
  [ -n "$target" ] && [ -n "${target//\//}" ] || return 1
  case "/${target}/" in
    */../*|*/./*) return 1 ;;
  esac
}

secure_directory() {
  if ! private_directory_target_safe "$1"; then
    echo "openbot-display: private directory must not resolve to the filesystem root: $1" >&2
    return 1
  fi
  if [ -L "$1" ]; then
    echo "openbot-display: private directory must not be a symlink: $1" >&2
    return 1
  fi
  mkdir -p "$1"
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  chmod 700 "$1"
}

pinchtab_owner_file() {
  echo "$(pinchtab_dir "$1")/bridge-owner.json"
}

pinchtab_lock_dir() {
  echo "$(pinchtab_dir "$1")/startup.lock"
}

x_lock_file() {
  echo "${X_LOCK_DIR}/.X${1}-lock"
}

x_socket_file() {
  echo "${X_SOCKET_DIR}/X${1}"
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

process_group_id() {
  local pid="$1"
  ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true
}

process_group_alive() {
  local pgid="$1"
  [ -n "$pgid" ] && kill -0 -- "-${pgid}" 2>/dev/null
}

display_process_command() {
  local pid="$1"
  if [ -r "/proc/${pid}/cmdline" ]; then
    tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true
    return
  fi
  ps -o command= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//' || true
}

display_owner_matches() {
  local n="$1"
  local pid="$2"
  local socket
  local command
  socket="$(x_socket_file "$n")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -S "$socket" ] || return 1
  command="$(display_process_command "$pid")"
  [[ "$command" =~ (^|[[:space:]/])(X|Xorg|Xvnc|Xtigervnc)([[:space:]].*)?[[:space:]]:${n}([[:space:]]|$) ]]
}

terminate_exact_process_or_group() {
  local pid="$1"
  local expected_start="$2"
  local expected_pgid="${3:-}"
  local pgid target i
  target="$pid"
  pgid=""
  if [ -n "$expected_pgid" ] && [ "$expected_pgid" = "$pid" ]; then
    pgid="$expected_pgid"
    if process_matches "$pid" "$expected_start"; then
      if [ "$(process_group_id "$pid")" != "$expected_pgid" ]; then
        return 1
      fi
    elif ! process_group_alive "$expected_pgid"; then
      return 0
    fi
    target="-${expected_pgid}"
  elif ! process_matches "$pid" "$expected_start"; then
    return 0
  fi
  # Revalidate the exact leader identity or captured live group immediately before TERM.
  if [ "$target" = "$pid" ]; then
    process_matches "$pid" "$expected_start" || return 0
  else
    if process_matches "$pid" "$expected_start" \
      && [ "$(process_group_id "$pid")" != "$expected_pgid" ]; then
      return 1
    fi
    process_group_alive "$expected_pgid" || return 0
  fi
  kill -TERM -- "$target" 2>/dev/null || true
  for i in $(seq 1 10); do
    if [ "$target" = "$pid" ]; then
      if ! process_matches "$pid" "$expected_start"; then
        wait "$pid" 2>/dev/null || true
        return 0
      fi
    elif ! process_group_alive "$pgid"; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  if [ "$target" = "$pid" ]; then
    if process_matches "$pid" "$expected_start"; then
      kill -KILL -- "$pid" 2>/dev/null || true
    fi
  elif process_group_alive "$pgid"; then
    kill -KILL -- "-${pgid}" 2>/dev/null || true
  fi
  for i in $(seq 1 10); do
    if [ "$target" = "$pid" ]; then
      if ! process_matches "$pid" "$expected_start"; then
        wait "$pid" 2>/dev/null || true
        return 0
      fi
    elif ! process_group_alive "$pgid"; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  return 1
}

pinchtab_lock_valid() {
  local n="$1"
  local lock pid start
  lock="$(pinchtab_lock_dir "$n")"
  [ -d "$lock" ] && [ ! -L "$lock" ] || return 1
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  start="$(cat "$lock/start" 2>/dev/null || true)"
  process_matches "$pid" "$start"
}

acquire_pinchtab_lock() {
  local n="$1"
  local lock deadline invalid_seen
  lock="$(pinchtab_lock_dir "$n")"
  secure_directory "$(dirname "$lock")" || return 1
  deadline=$((SECONDS + PINCHTAB_START_TIMEOUT_SEC + PINCHTAB_REQUEST_TIMEOUT_SEC + 5))
  invalid_seen=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    if mkdir "$lock" 2>/dev/null; then
      chmod 700 "$lock"
      printf '%s\n' "$$" >"$lock/pid"
      printf '%s\n' "$(process_start_id "$$")" >"$lock/start"
      chmod 600 "$lock/pid" "$lock/start"
      return 0
    fi
    if pinchtab_lock_valid "$n"; then
      invalid_seen=0
    else
      invalid_seen=$((invalid_seen + 1))
      if [ "$invalid_seen" -ge 10 ]; then
        echo "openbot-display: removing stale PinchTab startup lock for display :${n}" >&2
        if [ -L "$lock" ] || [ ! -d "$lock" ]; then
          rm -f -- "$lock"
        else
          rm -f "$lock/pid" "$lock/start"
          rmdir "$lock" 2>/dev/null || true
        fi
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
  [ -d "$lock" ] && [ ! -L "$lock" ] || return 0
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
  secure_directory "$(dirname "$file")" || return 1
  if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then return 1; fi
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
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
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

# Durable cookie contract:
# - COOKIE_JAR/current is the only source of truth and atomically points at one immutable snapshot.
# - display 1 uses google-chrome (or CHROME_USER_DATA_DIR); displays 2-8 use google-chrome-dN.
# - imports remove old profile cookie artifacts first and publish the snapshot epoch marker last.
# - exports preserve the epoch and publish a complete new snapshot last, so the last committed export wins.
# - clear publishes a new empty epoch before removing profile artifacts; old epoch markers can never export.
# - one COOKIE_JAR/.sync.lock serializes import, export, clear, Screen start/stop, and unpublished discard.
# - snapshot directories are mode 0700 and files are mode 0600; legacy root files are migration input only.
cookie_snapshot_root() {
  echo "$COOKIE_JAR/snapshots"
}

cookie_profile_epoch_file() {
  echo "$(profile_dir "$1")/.openbot-cookie-epoch"
}

cookie_profile_safe() {
  local n="$1"
  local profile path
  profile="$(profile_dir "$n")"
  for path in "$profile" "$profile/Default" "$profile/Default/Network"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      if [ ! -d "$path" ] || [ -L "$path" ]; then
        echo "openbot-display: cookie profile path must be a real directory: $path" >&2
        return 1
      fi
    fi
  done
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

manifest_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' "$file"
}

secure_cookie_store() {
  case "$COOKIE_JAR" in
    ""|/)
      echo "openbot-display: refusing unsafe cookie jar path" >&2
      return 1
      ;;
  esac
  if [ -L "$COOKIE_JAR" ]; then
    echo "openbot-display: cookie jar must not be a symlink" >&2
    return 1
  fi
  secure_directory "$COOKIE_JAR" || return 1
  secure_directory "$(cookie_snapshot_root)" || return 1
}

cookie_lock_dir() {
  echo "$COOKIE_JAR/.sync.lock"
}

cookie_lock_valid() {
  local lock pid start
  lock="$(cookie_lock_dir)"
  [ -d "$lock" ] && [ ! -L "$lock" ] || return 1
  pid=""
  start=""
  if [ -f "$lock/pid" ]; then IFS= read -r pid <"$lock/pid" || true; fi
  if [ -f "$lock/start" ]; then IFS= read -r start <"$lock/start" || true; fi
  process_matches "$pid" "$start"
}

acquire_cookie_lock() {
  local lock deadline invalid_seen
  secure_cookie_store || return 1
  lock="$(cookie_lock_dir)"
  deadline=$((SECONDS + 90))
  invalid_seen=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    if mkdir "$lock" 2>/dev/null; then
      chmod 700 "$lock"
      printf '%s\n' "$$" >"$lock/pid"
      printf '%s\n' "$(process_start_id "$$")" >"$lock/start"
      chmod 600 "$lock/pid" "$lock/start"
      return 0
    fi
    if cookie_lock_valid; then
      invalid_seen=0
    else
      invalid_seen=$((invalid_seen + 1))
      if [ "$invalid_seen" -ge 10 ]; then
        echo "openbot-display: removing stale cookie synchronization lock" >&2
        if [ -L "$lock" ] || [ ! -d "$lock" ]; then
          rm -f -- "$lock"
        else
          rm -f "$lock/pid" "$lock/start"
          rmdir "$lock" 2>/dev/null || true
        fi
        invalid_seen=0
        continue
      fi
    fi
    sleep 0.05
  done
  return 1
}

release_cookie_lock() {
  local lock pid start
  lock="$(cookie_lock_dir)"
  pid=""
  start=""
  if [ -f "$lock/pid" ]; then IFS= read -r pid <"$lock/pid" || true; fi
  if [ -f "$lock/start" ]; then IFS= read -r start <"$lock/start" || true; fi
  if [ "$pid" = "$$" ] && [ "$start" = "$(process_start_id "$$")" ]; then
    rm -f "$lock/pid" "$lock/start"
    rmdir "$lock" 2>/dev/null || true
  fi
}

cleanup_cookie_temporary_state() {
  local path name
  for path in "$COOKIE_JAR"/.staging.* "$COOKIE_JAR"/.current.tmp.* "$COOKIE_JAR"/.previous.tmp.*; do
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
    name="${path##*/}"
    case "$name" in
      .staging.*|.current.tmp.*|.previous.tmp.*) ;;
      *) return 1 ;;
    esac
    if [ -d "$path" ] && [ ! -L "$path" ]; then
      rm -rf -- "$path"
    else
      rm -f -- "$path"
    fi
  done
}

with_cookie_lock() {
  local result
  if ! acquire_cookie_lock; then
    echo "openbot-display: timed out waiting for cookie synchronization lock" >&2
    return 1
  fi
  if cleanup_cookie_temporary_state && "$@"; then result=0; else result=$?; fi
  release_cookie_lock
  return "$result"
}

copy_cookie_files_private() {
  local src="$1"
  local dest="$2"
  local f
  if [ -L "$src" ] || { [ -e "$src" ] && [ ! -d "$src" ]; }; then return 1; fi
  secure_directory "$dest" || return 1
  for f in $(cookie_files); do
    if [ -L "$src/$f" ]; then return 1; fi
    if [ -f "$src/$f" ]; then
      if ! cp "$src/$f" "$dest/$f"; then return 1; fi
      chmod 600 "$dest/$f"
    fi
  done
}

remove_cookie_files() {
  local dir="$1"
  local f
  for f in $(cookie_files); do
    rm -f "$dir/$f"
  done
}

copy_jar_layout() {
  local src="$1"
  local dest="$2"
  secure_directory "$dest" || return 1
  if [ -L "$src/Local State" ]; then return 1; fi
  if [ -f "$src/Local State" ]; then
    if ! cp "$src/Local State" "$dest/Local State"; then return 1; fi
    chmod 600 "$dest/Local State"
  fi
  copy_cookie_files_private "$src/Network" "$dest/Network" || return 1
  copy_cookie_files_private "$src" "$dest" || return 1
  if [ ! -f "$dest/Network/Cookies" ] && [ -f "$dest/Cookies" ]; then
    copy_cookie_files_private "$dest" "$dest/Network" || return 1
  fi
}

copy_profile_layout() {
  local profile="$1"
  local dest="$2"
  secure_directory "$dest" || return 1
  if [ -L "$profile/Local State" ]; then return 1; fi
  if [ -f "$profile/Local State" ]; then
    if ! cp "$profile/Local State" "$dest/Local State"; then return 1; fi
    chmod 600 "$dest/Local State"
  fi
  copy_cookie_files_private "$profile/Default/Network" "$dest/Network" || return 1
  copy_cookie_files_private "$profile/Default" "$dest" || return 1
  if [ ! -f "$dest/Network/Cookies" ] && [ -f "$dest/Cookies" ]; then
    copy_cookie_files_private "$dest" "$dest/Network" || return 1
  fi
}

snapshot_files_private() {
  local snapshot="$1"
  local dir f
  [ ! -L "$snapshot" ] || return 1
  [ "$(file_mode "$snapshot")" = "700" ] || return 1
  [ -f "$snapshot/manifest" ] && [ ! -L "$snapshot/manifest" ] \
    && [ "$(file_mode "$snapshot/manifest")" = "600" ] || return 1
  for dir in "$snapshot" "$snapshot/Network"; do
    [ -d "$dir" ] || continue
    [ "$(file_mode "$dir")" = "700" ] || return 1
    for f in $(cookie_files); do
      if [ -e "$dir/$f" ]; then
        [ -f "$dir/$f" ] && [ ! -L "$dir/$f" ] || return 1
        [ "$(file_mode "$dir/$f")" = "600" ] || return 1
      fi
    done
  done
  if [ -e "$snapshot/Local State" ]; then
    [ -f "$snapshot/Local State" ] && [ ! -L "$snapshot/Local State" ] || return 1
    [ "$(file_mode "$snapshot/Local State")" = "600" ] || return 1
  fi
}

cookie_snapshot_valid() {
  local snapshot="$1"
  local expected_generation="$2"
  local manifest="$snapshot/manifest"
  [ -d "$snapshot" ] || return 1
  [ "$(manifest_value "$manifest" schema 2>/dev/null || true)" = "1" ] || return 1
  [ "$(manifest_value "$manifest" state 2>/dev/null || true)" = "committed" ] || return 1
  [ "$(manifest_value "$manifest" generation 2>/dev/null || true)" = "$expected_generation" ] || return 1
  [[ "$(manifest_value "$manifest" epoch 2>/dev/null || true)" =~ ^[0-9]+$ ]] || return 1
  snapshot_files_private "$snapshot"
}

current_cookie_generation() {
  local link generation snapshot
  [ -L "$COOKIE_JAR/current" ] || return 1
  link="$(readlink "$COOKIE_JAR/current")"
  case "$link" in
    snapshots/generation-*) ;;
    *) return 1 ;;
  esac
  generation="${link#snapshots/}"
  case "$generation" in */*) return 1 ;; esac
  snapshot="$(cookie_snapshot_root)/$generation"
  cookie_snapshot_valid "$snapshot" "$generation" || return 1
  echo "$generation"
}

current_cookie_snapshot() {
  local generation
  generation="$(current_cookie_generation)" || return 1
  echo "$(cookie_snapshot_root)/$generation"
}

current_cookie_epoch() {
  local snapshot
  snapshot="$(current_cookie_snapshot)" || return 1
  manifest_value "$snapshot/manifest" epoch
}

create_cookie_snapshot() {
  local source_kind="$1"
  local source="$2"
  local epoch="$3"
  local stage stage_name generation snapshot
  secure_cookie_store || return 1
  stage="$(mktemp -d "$COOKIE_JAR/.staging.XXXXXXXX")" || return 1
  chmod 700 "$stage"
  if [ "$source_kind" = "profile" ]; then
    if ! copy_profile_layout "$source" "$stage"; then rm -rf "$stage"; return 1; fi
  elif [ "$source_kind" = "jar" ]; then
    if ! copy_jar_layout "$source" "$stage"; then rm -rf "$stage"; return 1; fi
  elif [ "$source_kind" != "empty" ]; then
    rm -rf "$stage"
    return 1
  fi
  stage_name="${stage##*/}"
  generation="generation-${stage_name#.staging.}"
  printf 'schema=1\nstate=committed\ngeneration=%s\nepoch=%s\n' "$generation" "$epoch" >"$stage/manifest"
  chmod 600 "$stage/manifest"
  snapshot="$(cookie_snapshot_root)/$generation"
  if ! mv "$stage" "$snapshot"; then rm -rf "$stage"; return 1; fi
  if ! cookie_snapshot_valid "$snapshot" "$generation"; then
    rm -rf -- "$snapshot"
    return 1
  fi
  echo "$generation"
}

set_cookie_pointer() {
  local name="$1"
  local generation="$2"
  local tmp="$COOKIE_JAR/.${name}.tmp.$$"
  rm -f "$tmp"
  ln -s "snapshots/$generation" "$tmp"
  if [ "$(uname -s)" = "Darwin" ]; then
    mv -fh "$tmp" "$COOKIE_JAR/$name"
  else
    mv -Tf "$tmp" "$COOKIE_JAR/$name"
  fi
}

commit_cookie_snapshot() {
  local generation="$1"
  local prior=""
  local snapshot="$(cookie_snapshot_root)/$generation"
  cookie_snapshot_valid "$snapshot" "$generation" || return 1
  prior="$(current_cookie_generation 2>/dev/null || true)"
  if [ -n "$prior" ]; then set_cookie_pointer previous "$prior" || return 1; fi
  set_cookie_pointer current "$generation" || return 1
  [ "$(current_cookie_generation)" = "$generation" ] || return 1
}

remove_legacy_cookie_root() {
  remove_cookie_files "$COOKIE_JAR"
  remove_cookie_files "$COOKIE_JAR/Network"
  rm -f "$COOKIE_JAR/Local State"
  rmdir "$COOKIE_JAR/Network" 2>/dev/null || true
}

ensure_cookie_store() {
  local generation
  secure_cookie_store || return 1
  if [ -e "$COOKIE_JAR/current" ] || [ -L "$COOKIE_JAR/current" ]; then
    current_cookie_generation >/dev/null || {
      echo "openbot-display: committed cookie snapshot is invalid" >&2
      return 1
    }
    remove_legacy_cookie_root
    return 0
  fi
  generation="$(create_cookie_snapshot jar "$COOKIE_JAR" 1)" || return 1
  commit_cookie_snapshot "$generation" || return 1
  remove_legacy_cookie_root
}

checkpoint_cookie_db() {
  local db="$1"
  if [ -f "$db" ] && [ ! -L "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" "PRAGMA wal_checkpoint(FULL);" >/dev/null 2>&1 || true
  fi
}

cookies_in() {
  local n="$1"
  local profile snapshot epoch marker marker_tmp user_group
  ensure_cookie_store || return 1
  profile="$(profile_dir "$n")"
  snapshot="$(current_cookie_snapshot)" || return 1
  epoch="$(current_cookie_epoch)" || return 1
  marker="$(cookie_profile_epoch_file "$n")"
  cookie_profile_safe "$n" || return 1
  secure_directory "$profile" || return 1
  secure_directory "$profile/Default" || return 1
  secure_directory "$profile/Default/Network" || return 1
  remove_cookie_files "$profile/Default/Network"
  remove_cookie_files "$profile/Default"
  rm -f "$profile/Local State" "$marker"
  if [ -f "$snapshot/Local State" ]; then
    cp "$snapshot/Local State" "$profile/Local State" || return 1
    chmod 600 "$profile/Local State"
  fi
  copy_cookie_files_private "$snapshot/Network" "$profile/Default/Network" || return 1
  copy_cookie_files_private "$snapshot" "$profile/Default" || return 1
  if [ ! -f "$profile/Default/Network/Cookies" ] && [ -f "$snapshot/Cookies" ]; then
    copy_cookie_files_private "$snapshot" "$profile/Default/Network" || return 1
  fi
  marker_tmp="${marker}.tmp.$$"
  printf '%s\n' "$epoch" >"$marker_tmp"
  chmod 600 "$marker_tmp"
  mv -f "$marker_tmp" "$marker"
  user_group="$(id -gn "$USER_NAME" 2>/dev/null || true)"
  if [ -n "$user_group" ]; then
    chown -R "$USER_NAME:$user_group" "$profile" || true
  else
    chown -R "$USER_NAME" "$profile" || true
  fi
}

cookies_out() {
  local n="$1"
  local profile epoch marker marker_epoch generation
  ensure_cookie_store || return 1
  profile="$(profile_dir "$n")"
  cookie_profile_safe "$n" || return 1
  epoch="$(current_cookie_epoch)" || return 1
  marker="$(cookie_profile_epoch_file "$n")"
  marker_epoch=""
  if [ -f "$marker" ]; then IFS= read -r marker_epoch <"$marker" || true; fi
  if [ "$marker_epoch" != "$epoch" ]; then
    echo "openbot-display: cookie profile :${n} was invalidated; import it before export" >&2
    return 1
  fi
  checkpoint_cookie_db "$profile/Default/Network/Cookies"
  checkpoint_cookie_db "$profile/Default/Cookies"
  generation="$(create_cookie_snapshot profile "$profile" "$epoch")" || return 1
  commit_cookie_snapshot "$generation" || return 1
  echo "openbot-display: cookie export committed generation ${generation}"
}

cookies_clear() {
  local epoch next_epoch generation current profile n snapshot cleanup_failed
  ensure_cookie_store || return 1
  epoch="$(current_cookie_epoch)" || return 1
  next_epoch=$((epoch + 1))
  generation="$(create_cookie_snapshot empty "" "$next_epoch")" || return 1
  commit_cookie_snapshot "$generation" || return 1
  cleanup_failed=0
  for n in $(seq 1 8); do
    profile="$(profile_dir "$n")"
    if ! cookie_profile_safe "$n"; then
      cleanup_failed=1
      continue
    fi
    remove_cookie_files "$profile/Default/Network"
    remove_cookie_files "$profile/Default"
    rm -f "$profile/Local State" "$(cookie_profile_epoch_file "$n")"
  done
  rm -f "$COOKIE_JAR/previous"
  current="$(current_cookie_generation)" || return 1
  for snapshot in "$(cookie_snapshot_root)"/generation-*; do
    [ -d "$snapshot" ] || continue
    if [ "${snapshot##*/}" != "$current" ]; then rm -rf -- "$snapshot"; fi
  done
  [ "$(current_cookie_generation)" = "$generation" ] || return 1
  if [ "$cleanup_failed" != "0" ]; then
    echo "openbot-display: cookie clear committed but one or more unsafe profile paths require manual cleanup" >&2
    return 1
  fi
  echo "openbot-display: cookie clear committed generation ${generation}"
}

pinchtab_config() {
  local n="$1"
  local port token dir cfg tmp auth auth_tmp profile base name cdp
  port="$(pinchtab_port "$n")"
  cdp="$(cdp_port "$n")"
  token="${PINCHTAB_TOKEN:-}"
  dir="$(pinchtab_dir "$n")"
  cfg="${dir}/config.json"
  auth="$(pinchtab_authorization_file "$n")"
  profile="$(profile_dir "$n")"
  base="$(dirname "$profile")"
  name="$(basename "$profile")"
  secure_directory "$dir" || return 1
  if [ -L "$cfg" ] || [ -L "$auth" ] \
    || { [ -e "$cfg" ] && [ ! -f "$cfg" ]; } \
    || { [ -e "$auth" ] && [ ! -f "$auth" ]; }; then
    echo "openbot-display: PinchTab credential state must not be a symlink" >&2
    return 1
  fi
  mkdir -p "$profile"
  auth_tmp="${auth}.tmp.$$"
  printf 'Authorization: Bearer %s\n' "$token" >"$auth_tmp"
  chmod 600 "$auth_tmp"
  mv -f "$auth_tmp" "$auth"
  tmp="${cfg}.tmp.$$"
  PINCHTAB_TOKEN="$token" jq -n \
    --arg port "$port" \
    --arg stateDir "$dir" \
    --argjson remoteDebuggingPort "$cdp" \
    --arg baseDir "$base" \
    --arg defaultProfile "$name" \
    '{
      server: {port:$port,bind:"0.0.0.0",token:env.PINCHTAB_TOKEN,stateDir:$stateDir},
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
  local n="$1"
  local port="$2"
  local total_timeout="${3:-$PINCHTAB_REQUEST_TIMEOUT_SEC}"
  pinchtab_curl "$total_timeout" \
    -H "@$(pinchtab_authorization_file "$n")" \
    "http://127.0.0.1:${port}/health" >/dev/null 2>&1
}

wait_bridge() {
  local n="$1"
  local port="$2"
  local timeout="${3:-$PINCHTAB_START_TIMEOUT_SEC}"
  local deadline remaining request_timeout health_seen
  deadline=$((SECONDS + timeout))
  health_seen=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    request_timeout="$PINCHTAB_REQUEST_TIMEOUT_SEC"
    if [ "$remaining" -lt "$request_timeout" ]; then
      request_timeout="$remaining"
    fi
    if pinchtab_health "$n" "$port" "$request_timeout"; then
      health_seen=1
      remaining=$((deadline - SECONDS))
      if [ "$remaining" -gt 0 ]; then
        request_timeout="$PINCHTAB_REQUEST_TIMEOUT_SEC"
        if [ "$remaining" -lt "$request_timeout" ]; then
          request_timeout="$remaining"
        fi
        if ensure_chrome "$n" "$port" "$request_timeout"; then
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
  local n="$1"
  local port="$2"
  local total_timeout="${3:-$PINCHTAB_REQUEST_TIMEOUT_SEC}"
  pinchtab_curl "$total_timeout" -X POST \
    -H "@$(pinchtab_authorization_file "$n")" \
    -H "content-type: application/json" \
    "http://127.0.0.1:${port}/ensure-browser" >/dev/null 2>&1
}

bridge_ready() {
  local n="$1"
  local port="$2"
  pinchtab_health "$n" "$port" \
    && ensure_chrome "$n" "$port"
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
  if [ -L "$file" ]; then
    echo "openbot-display: refusing symlinked PinchTab owner state on :${n}" >&2
    return 1
  fi
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
  for i in $(seq 1 20); do
    if ! process_matches "$child_pid" "$child_start" \
      && ! process_matches "$supervisor_pid" "$supervisor_start"; then
      rm -f "$file"
      return 0
    fi
    sleep 0.1
  done
  echo "openbot-display: PinchTab cleanup incomplete on :${n}; exact owner ${file} retained for retry" >&2
  return 1
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
    echo "openbot-display: PinchTab port ${port} remains occupied after bounded cleanup; no unverified process was killed" >&2
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
  local pt cfg log owner i ready_status provisional_pid provisional_start provisional_pgid
  local startup_deadline owner_deadline remaining
  pt="$(pinchtab_port "$n")"
  cfg="$(pinchtab_config "$n")"
  log="$(pinchtab_dir "$n")/bridge.log"
  owner="$(pinchtab_owner_file "$n")"
  secure_directory "$(dirname "$log")" || return 1
  if [ -L "$log" ] || { [ -e "$log" ] && [ ! -f "$log" ]; }; then
    echo "openbot-display: PinchTab log must not be a symlink" >&2
    return 1
  fi
  touch "$log"
  chmod 600 "$log"
  if pinchtab_owner_valid "$n" "$pt" && bridge_ready "$n" "$pt"; then
    echo "openbot-display: PinchTab bridge :${pt} already supervised"
    return 0
  fi
  if ! pinchtab_stop_locked "$n"; then
    echo "openbot-display: refusing to start a duplicate PinchTab owner on :${n}" >&2
    return 1
  fi
  if pinchtab_port_in_use "$pt"; then
    echo "openbot-display: PinchTab port ${pt} is already in use without a valid owner" >&2
    return 1
  fi

  # One new session owns one supervisor and child for this display.
  startup_deadline=$((SECONDS + PINCHTAB_START_TIMEOUT_SEC))
  OPENBOT_PINCHTAB_LOCK_PID="$$" \
    OPENBOT_PINCHTAB_LOCK_START="$(process_start_id "$$")" \
    "$SETSID_BIN" bash "$SCRIPT_PATH" pinchtab-supervise "$n" >>"$log" 2>&1 < /dev/null &
  provisional_pid=$!
  provisional_start=""
  provisional_pgid=""
  for i in $(seq 1 50); do
    provisional_start="$(process_start_id "$provisional_pid")"
    provisional_pgid="$(process_group_id "$provisional_pid")"
    if [ -n "$provisional_start" ] && [ "$provisional_pgid" = "$provisional_pid" ]; then
      break
    fi
    sleep 0.01
  done
  if [ -z "$provisional_start" ] || [ "$provisional_pgid" != "$provisional_pid" ]; then
    echo "openbot-display: PinchTab supervisor did not establish a verifiable process group" >&2
    if [ -n "$provisional_start" ]; then
      terminate_exact_process_or_group "$provisional_pid" "$provisional_start" "" || true
    else
      kill -KILL -- "$provisional_pid" 2>/dev/null || true
    fi
    pinchtab_stop_locked "$n"
    return 1
  fi
  owner_deadline=$((SECONDS + 5))
  if [ "$startup_deadline" -lt "$owner_deadline" ]; then
    owner_deadline="$startup_deadline"
  fi
  while [ "$SECONDS" -lt "$owner_deadline" ]; do
    if pinchtab_owner_valid "$n" "$pt"; then
      break
    fi
    sleep 0.1
  done
  if ! pinchtab_owner_valid "$n" "$pt"; then
    echo "openbot-display: PinchTab supervisor did not publish owner ${owner}" >&2
    if ! terminate_exact_process_or_group "$provisional_pid" "$provisional_start" "$provisional_pgid"; then
      echo "openbot-display: provisional PinchTab supervisor ${provisional_pid} survived bounded TERM/KILL cleanup" >&2
    fi
    pinchtab_stop_locked "$n"
    return 1
  fi
  remaining=$((startup_deadline - SECONDS))
  if [ "$remaining" -le 0 ]; then
    echo "openbot-display: PinchTab startup exhausted its $(pinchtab_deadline_summary) before readiness checks" >&2
    pinchtab_stop_locked "$n"
    return 1
  fi
  if wait_bridge "$n" "$pt" "$remaining"; then
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
  local result token_dir
  if [ -z "${PINCHTAB_TOKEN:-}" ]; then
    token_dir="$(dirname "$PINCHTAB_TOKEN_FILE")"
    if ! private_directory_target_safe "$token_dir" \
      || [ -L "$token_dir" ] || [ -L "$PINCHTAB_TOKEN_FILE" ] \
      || { [ -e "$PINCHTAB_TOKEN_FILE" ] && [ ! -f "$PINCHTAB_TOKEN_FILE" ]; }; then
      echo "openbot-display: PinchTab token state must use real private files" >&2
      return 1
    fi
    if [ -f "$PINCHTAB_TOKEN_FILE" ]; then
      chmod 700 "$token_dir"
      chmod 600 "$PINCHTAB_TOKEN_FILE"
      IFS= read -r PINCHTAB_TOKEN <"$PINCHTAB_TOKEN_FILE" || true
      export PINCHTAB_TOKEN
    fi
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
  for i in $(seq 1 10); do
    if ! pgrep -af -- "$pat" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "openbot-display: Chrome still owns profile ${profile} after bounded TERM/KILL cleanup" >&2
  return 1
}

display_state_directory_safe() {
  local path="$1"
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
    echo "openbot-display: unpublished display state must use a real directory: ${path}" >&2
    return 1
  fi
}

discard_directories_safe() {
  local n="$1"
  display_state_directory_safe "$HOME_DIR" || return 1
  display_state_directory_safe "$HOME_DIR/.config" || return 1
  display_state_directory_safe "$(profile_dir "$n")" || return 1
  display_state_directory_safe "$(config_dir "$n")" || return 1
  display_state_directory_safe "$(pinchtab_dir "$n")" || return 1
  display_state_directory_safe "$HOME_DIR/.vnc" || return 1
}

discard_x_state_safe() {
  local n="$1"
  local x_lock
  local x_socket
  local x_pid=""
  x_lock="$(x_lock_file "$n")"
  x_socket="$(x_socket_file "$n")"
  if [ -L "$x_lock" ] || [ -L "$x_socket" ]; then
    echo "openbot-display: refusing symlinked X state for unpublished display :${n}" >&2
    return 1
  fi
  if [ -e "$x_lock" ] && [ ! -f "$x_lock" ]; then
    echo "openbot-display: X lock for unpublished display :${n} is not a regular file" >&2
    return 1
  fi
  if [ -e "$x_socket" ] && [ ! -S "$x_socket" ]; then
    echo "openbot-display: X socket path for unpublished display :${n} is not a Unix socket" >&2
    return 1
  fi
  if [ -S "$x_socket" ]; then
    if [ ! -f "$x_lock" ]; then
      echo "openbot-display: unpublished display :${n} has an X socket without an ownership lock" >&2
      return 1
    fi
    x_pid="$(awk 'NR == 1 { print $1 }' "$x_lock" 2>/dev/null || true)"
    if ! [[ "$x_pid" =~ ^[0-9]+$ ]] || ! display_owner_matches "$n" "$x_pid"; then
      echo "openbot-display: X socket for unpublished display :${n} lacks coherent verified ownership; refusing cleanup" >&2
      return 1
    fi
  elif [ -f "$x_lock" ]; then
    x_pid="$(awk 'NR == 1 { print $1 }' "$x_lock" 2>/dev/null || true)"
    if [[ "$x_pid" =~ ^[0-9]+$ ]] && kill -0 "$x_pid" 2>/dev/null; then
      echo "openbot-display: X lock for unpublished display :${n} names foreign live ownership; refusing cleanup" >&2
      return 1
    fi
  fi
}

discard_pinchtab() {
  local n="$1"
  local state owner port supervisor_pid supervisor_start child_pid child_start result
  state="$(pinchtab_dir "$n")"
  port="$(pinchtab_port "$n")"
  if [ ! -e "$state" ] && [ ! -L "$state" ]; then
    if pinchtab_port_in_use "$port"; then
      echo "openbot-display: PinchTab port ${port} is occupied without owned unpublished state" >&2
      return 1
    fi
    return 0
  fi
  display_state_directory_safe "$state" || return 1
  if ! acquire_pinchtab_lock "$n"; then
    echo "openbot-display: timed out waiting for unpublished PinchTab cleanup on :${n}" >&2
    return 1
  fi
  result=0
  owner="$(pinchtab_owner_file "$n")"
  if [ -e "$owner" ] || [ -L "$owner" ]; then
    if [ -L "$owner" ] || [ ! -f "$owner" ]; then
      echo "openbot-display: refusing unsafe PinchTab owner state on unpublished display :${n}" >&2
      result=1
    else
      supervisor_pid="$(owner_field "$owner" supervisorPid)"
      supervisor_start="$(owner_field "$owner" supervisorStart)"
      child_pid="$(owner_field "$owner" childPid)"
      child_start="$(owner_field "$owner" childStart)"
      if { [[ "$supervisor_pid" =~ ^[0-9]+$ ]] && kill -0 "$supervisor_pid" 2>/dev/null; } \
        || { [[ "$child_pid" =~ ^[0-9]+$ ]] && kill -0 "$child_pid" 2>/dev/null; }; then
        if pinchtab_owner_valid "$n" "$port"; then
          if ! pinchtab_stop_locked "$n"; then result=1; fi
        else
          echo "openbot-display: PinchTab owner state on unpublished display :${n} names foreign live ownership" >&2
          result=1
        fi
      elif ! rm -f -- "$owner"; then
        echo "openbot-display: failed to remove stale PinchTab owner state on unpublished display :${n}" >&2
        result=1
      fi
    fi
  fi
  if pinchtab_port_in_use "$port"; then
    echo "openbot-display: PinchTab port ${port} remains occupied after unpublished cleanup" >&2
    result=1
  fi
  release_pinchtab_lock "$n"
  return "$result"
}

discard_x_state() {
  local n="$1"
  local x_lock
  local x_socket
  local x_pid=""
  local i
  x_lock="$(x_lock_file "$n")"
  x_socket="$(x_socket_file "$n")"
  discard_x_state_safe "$n" || return 1
  if [ -f "$x_lock" ]; then
    x_pid="$(awk 'NR == 1 { print $1 }' "$x_lock" 2>/dev/null || true)"
  fi
  if display_owner_matches "$n" "$x_pid"; then
    if ! su -s /bin/bash "$USER_NAME" -c "vncserver -kill :${n}" >/dev/null 2>&1; then
      echo "openbot-display: failed to stop owned VNC for unpublished display :${n}" >&2
      return 1
    fi
    for i in $(seq 1 20); do
      if ! display_owner_matches "$n" "$x_pid"; then break; fi
      sleep 0.1
    done
    if display_owner_matches "$n" "$x_pid"; then
      echo "openbot-display: owned VNC survived cleanup for unpublished display :${n}" >&2
      return 1
    fi
  fi
  discard_x_state_safe "$n" || return 1
  if ! rm -f -- "$x_lock" "$x_socket"; then
    echo "openbot-display: failed to remove X state for unpublished display :${n}" >&2
    return 1
  fi
}

remove_discarded_directory() {
  local path="$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then return 0; fi
  display_state_directory_safe "$HOME_DIR" || return 1
  case "$path" in
    "$HOME_DIR/.config/"*) display_state_directory_safe "$HOME_DIR/.config" || return 1 ;;
  esac
  display_state_directory_safe "$path" || return 1
  if ! rm -rf -- "$path"; then
    echo "openbot-display: failed to remove unpublished display state: ${path}" >&2
    return 1
  fi
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo "openbot-display: unpublished display state survived cleanup: ${path}" >&2
    return 1
  fi
}

discard_display() {
  local n="$1"
  discard_directories_safe "$n" || return 1
  discard_x_state_safe "$n" || return 1
  discard_pinchtab "$n" || return 1
  stop_chrome "$n" || return 1
  discard_x_state "$n" || return 1
  remove_discarded_directory "$(profile_dir "$n")" || return 1
  remove_discarded_directory "$(config_dir "$n")" || return 1
  remove_discarded_directory "$(pinchtab_dir "$n")" || return 1
}

stop_display() {
  local n="$1"
  local result=0
  local prior=""
  local current=""
  if ensure_cookie_store; then
    prior="$(current_cookie_generation)" || prior=""
  else
    echo "openbot-display: no valid committed cookie generation is recoverable before stop" >&2
    result=1
  fi
  if ! pinchtab_stop "$n"; then result=1; fi
  if ! stop_chrome "$n"; then
    echo "openbot-display: failed to stop Chrome for display :${n}" >&2
    result=1
    current="$(current_cookie_generation 2>/dev/null || true)"
    if [ -n "$prior" ] && [ "$current" = "$prior" ]; then
      echo "openbot-display: cookie export not committed; prior generation ${prior} preserved" >&2
    else
      echo "openbot-display: cookie export not committed and no verified prior generation remains" >&2
    fi
  elif ! cookies_out "$n"; then
    echo "openbot-display: failed to commit cookies for display :${n}" >&2
    current="$(current_cookie_generation 2>/dev/null || true)"
    if [ -n "$prior" ] && [ "$current" = "$prior" ]; then
      echo "openbot-display: cookie export not committed; prior generation ${prior} preserved" >&2
    else
      echo "openbot-display: cookie export failed without preserving the expected generation" >&2
    fi
    result=1
  fi
  if [[ "$n" =~ ^[2-8]$ ]]; then
    su -s /bin/bash "$USER_NAME" -c "vncserver -kill :${n}" 2>/dev/null || true
    if ! rm -f "$(x_lock_file "$n")" "$(x_socket_file "$n")"; then
      echo "openbot-display: failed to remove X state for display :${n}" >&2
      result=1
    fi
  fi
  return "$result"
}

start_display() {
  local n="$1"
  local ws_port=$((6900 + n))
  local x_lock
  local x_socket
  x_lock="$(x_lock_file "$n")"
  x_socket="$(x_socket_file "$n")"
  if [ -e "$x_lock" ]; then
    local x_pid
    x_pid="$(awk 'NR == 1 { print $1 }' "$x_lock" 2>/dev/null || true)"
    if display_owner_matches "$n" "$x_pid"; then
      echo "display :${n} already up"
      if [ -n "${PINCHTAB_TOKEN:-}" ]; then
        pinchtab_start "$n"
      fi
      return 0
    fi
    if [[ "$x_pid" =~ ^[0-9]+$ ]] && kill -0 "$x_pid" 2>/dev/null && [ -S "$x_socket" ]; then
      echo "openbot-display: display :${n} X lock and socket have mismatched live ownership; refusing to remove or kill PID ${x_pid}" >&2
      return 1
    fi
    echo "openbot-display: removing stale or incoherent X state for display :${n}; PID ${x_pid:-unknown} is not a coherent owner" >&2
  elif [ -S "$x_socket" ]; then
    echo "openbot-display: display :${n} has an X socket without an ownership lock; refusing unsafe replacement" >&2
    return 1
  fi
  rm -f "$x_lock" "$x_socket"
  seed_display "$n"
  cookies_in "$n"
  export PINCHTAB_TOKEN
  su -s /bin/bash "$USER_NAME" -c "vncserver :${n} -geometry 1280x800 -depth 24 -websocketPort ${ws_port} -xstartup /etc/openbot/xstartup"
}

case "$CMD" in
  start)
    with_cookie_lock start_display "$N"
    ;;
  stop)
    with_cookie_lock stop_display "$N"
    ;;
  discard)
    with_cookie_lock discard_display "$N"
    ;;
  seed)
    seed_display "$N"
    ;;
  cookies-in)
    with_cookie_lock cookies_in "$N"
    ;;
  cookies-out)
    with_cookie_lock cookies_out "$N"
    ;;
  cookies-clear)
    with_cookie_lock cookies_clear
    ;;
  pinchtab)
    pinchtab_start "$N"
    ;;
  pinchtab-supervise)
    pinchtab_supervise "$N"
    ;;
  *)
    echo "usage: openbot-display start <n> | stop <n> | discard <n> | seed <n> | cookies-in <n> | cookies-out <n> | cookies-clear <n> | pinchtab <n>" >&2
    exit 1
    ;;
esac
