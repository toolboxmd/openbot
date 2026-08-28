#!/bin/bash
set +x
set -euo pipefail
umask 077

private_directory_target_safe() {
  local target="$1"
  [ -n "$target" ] && [ -n "${target//\//}" ] || return 1
  case "/${target}/" in
    */../*|*/./*) return 1 ;;
  esac
}

prepare_pinchtab_token() {
  local token_file token_dir token_tmp
  token_file="${OPENBOT_PINCHTAB_TOKEN_FILE:-/etc/openbot/secrets/pinchtab.token}"
  token_dir="$(dirname "$token_file")"
  if ! private_directory_target_safe "$token_dir"; then
    echo "openbot-entrypoint: PinchTab token directory must not resolve to the filesystem root" >&2
    return 1
  fi
  if [ -L "$token_dir" ]; then
    echo "openbot-entrypoint: PinchTab token directory must not be a symlink" >&2
    return 1
  fi
  mkdir -p "$token_dir"
  chmod 700 "$token_dir"
  chown "$(id -u):$(id -g)" "$token_dir"
  if [ -L "$token_file" ] || { [ -e "$token_file" ] && [ ! -f "$token_file" ]; }; then
    echo "openbot-entrypoint: PinchTab token file must be a regular private file" >&2
    return 1
  fi
  if [ -z "${PINCHTAB_TOKEN:-}" ]; then
    rm -f "$token_file"
    return 0
  fi
  token_tmp="$(mktemp "${token_file}.tmp.XXXXXXXX")"
  printf '%s' "$PINCHTAB_TOKEN" >"$token_tmp"
  chmod 600 "$token_tmp"
  mv -f "$token_tmp" "$token_file"
  chmod 600 "$token_file"
  chown "$(id -u):$(id -g)" "$token_file"
}

USER_NAME="${VNC_USER:-openbot}"
PASSWORD="${VNC_PASSWORD:-openbot}"
export DISPLAY="${DISPLAY:-:1}"
export HOME="/home/${USER_NAME}"
export USER="${USER_NAME}"
export XDG_RUNTIME_DIR="/tmp/runtime-${USER_NAME}"
COOKIE_JAR="${COOKIE_JAR:-/computer/cookies}"
if ! private_directory_target_safe "$COOKIE_JAR"; then
  echo "openbot-entrypoint: cookie jar must not resolve to the filesystem root" >&2
  exit 1
fi
export PINCHTAB_TOKEN="${PINCHTAB_TOKEN:-}"
prepare_pinchtab_token
if [ "${1:-}" = "prepare-pinchtab-token" ]; then
  exit 0
fi

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G ssl-cert "$USER_NAME"
else
  usermod -aG ssl-cert "$USER_NAME" || true
fi

mkdir -p /run/dbus "$XDG_RUNTIME_DIR" "$COOKIE_JAR" /workspace
chmod 700 "$XDG_RUNTIME_DIR" "$COOKIE_JAR"
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

CLEANUP_STARTED=0
CLEANUP_RESULT=0
cleanup() {
  if [ "$CLEANUP_STARTED" = "1" ]; then return "$CLEANUP_RESULT"; fi
  CLEANUP_STARTED=1
  trap - TERM INT EXIT
  local result=0
  if ! /usr/local/bin/openbot-display stop 1; then result=1; fi
  if [ -n "${VNC_PID:-}" ]; then
    kill "$VNC_PID" 2>/dev/null || true
    wait "$VNC_PID" 2>/dev/null || true
  fi
  CLEANUP_RESULT="$result"
  return "$result"
}

signal_cleanup() {
  if cleanup; then exit 0; else exit "$?"; fi
}

exit_cleanup() {
  local status="$?"
  if ! cleanup; then status=1; fi
  exit "$status"
}

trap signal_cleanup TERM INT
trap exit_cleanup EXIT

# Stay PID 1 so docker stop can dump the cookie jar. Display :1 stays lit.
su -s /bin/bash "$USER_NAME" -c "vncserver ${DISPLAY} -fg -geometry 1280x800 -depth 24 -websocketPort 6901 -xstartup /etc/openbot/xstartup" &
VNC_PID=$!
wait "$VNC_PID"
