#!/usr/bin/env bash
# ╔══════════════════════════════════════════╗
# ║          cURL DOOM  /  play.sh           ║
# ║         DOOM, played over curl.          ║
# ╚══════════════════════════════════════════╝
#
# This is the script the server hands out at GET /. It's identical to the
# bundled doom.sh except __SERVER__ is rewritten on the fly to whichever
# host you fetched it from, so `curl -sL doom.example.com | bash` works
# without any further configuration.

SERVER="${DOOM_SERVER:-__SERVER__}"
CURL_OPTS=(-s --max-time 10)

ESC=$(printf '\033')
CLEAR="${ESC}[2J${ESC}[H"
SHOW_CURSOR="${ESC}[?25h"
HIDE_CURSOR="${ESC}[?25l"

SESSION=""

cleanup() {
  if [ -n "$SESSION" ]; then
    curl "${CURL_OPTS[@]}" -X POST "$SERVER/quit?s=$SESSION" >/dev/null 2>&1 || true
  fi
  tput cnorm 2>/dev/null || printf '%s' "${SHOW_CURSOR}"
  tput rmcup 2>/dev/null
  stty sane 2>/dev/null
  echo ""
  echo "Thanks for playing cURL DOOM!"
  exit 0
}
trap cleanup EXIT INT TERM

# dependency check

for dep in curl stty tput; do
  command -v "$dep" >/dev/null 2>&1 || { echo "Error: '$dep' required." >&2; exit 1; }
done

# terminal size to server viewport
#
# Detection reads /dev/tty directly via stty, which goes through ioctl
# (TIOCGWINSZ) and is the most reliable source, `tput cols` can return
# stale values, and when invoked under `curl | bash` stdin isn't a tty
# at all, so $LINES/$COLUMNS aren't set either.

detect_size() {
  local sz
  sz=$(stty size < /dev/tty 2>/dev/null)
  if [ -n "$sz" ]; then
    DETECTED_ROWS=${sz%% *}
    DETECTED_COLS=${sz##* }
    return 0
  fi
  DETECTED_COLS=$(tput cols 2>/dev/null)
  DETECTED_ROWS=$(tput lines 2>/dev/null)
  if [ -n "$DETECTED_COLS" ] && [ -n "$DETECTED_ROWS" ]; then
    return 0
  fi
  DETECTED_COLS="${COLUMNS:-100}"
  DETECTED_ROWS="${LINES:-40}"
}

detect_size
COLS="${DOOM_COLS:-$DETECTED_COLS}"
ROWS="${DOOM_ROWS:-$DETECTED_ROWS}"
# Leave one row for the shell prompt after exit.
[ -z "$DOOM_ROWS" ] && [ "$ROWS" -gt 1 ] && ROWS=$((ROWS - 1))

# Clamp to server-accepted range (mirrors MAX_COLS/MAX_ROWS in index.js).
[ "$COLS" -lt 20  ] && COLS=20
[ "$COLS" -gt 320 ] && COLS=320
[ "$ROWS" -lt 10  ] && ROWS=10
[ "$ROWS" -gt 100 ] && ROWS=100

DIMS="cols=${COLS}&rows=${ROWS}"

echo "Terminal: ${DETECTED_COLS}x${DETECTED_ROWS}  ->  using ${COLS}x${ROWS}"

# start session

echo "Connecting to $SERVER ..."
HEADERS_FILE=$(mktemp -t curldoom_headers.XXXXXX)
BODY_FILE=$(mktemp -t curldoom_body.XXXXXX)
trap 'rm -f "$HEADERS_FILE" "$BODY_FILE"; cleanup' EXIT INT TERM

if ! curl "${CURL_OPTS[@]}" -X POST "$SERVER/new?$DIMS" \
     -D "$HEADERS_FILE" -o "$BODY_FILE"; then
  echo "Error: could not reach $SERVER" >&2
  echo "Start the server with: npm start" >&2
  exit 1
fi

SESSION=$(grep -i '^x-session:' "$HEADERS_FILE" | awk '{print $2}' | tr -d '\r\n')
if [ -z "$SESSION" ]; then
  echo "Error: server did not return a session id." >&2
  echo "Response body:" >&2
  cat "$BODY_FILE" >&2
  exit 1
fi

# enter alternate screen

tput smcup 2>/dev/null
printf '%s' "${HIDE_CURSOR}"
printf '%s' "${CLEAR}"
cat "$BODY_FILE"

# Read straight from /dev/tty so this works under `curl | bash`, where
# stdin is the curl pipe (not a tty) and `read` would otherwise see EOF.
stty -echo -icanon min 1 time 0 < /dev/tty 2>/dev/null

send_key() {
  local key="$1"
  [ "$key" = ' ' ] && key='%20'
  FRAME=$(curl "${CURL_OPTS[@]}" -X POST "$SERVER/tick?s=${SESSION}&key=${key}&${DIMS}")
  # Frames start with cursor-home (\x1b[H) and overwrite the previous frame
  # in place, no per-frame CLEAR, which used to cause a visible flicker.
  [ -n "$FRAME" ] && printf '%s' "$FRAME"
}

# key reading loop
#
# Supported keys (mapped server-side):
#   w/a/s/d      move / turn          arrows: same
#   ,  .         strafe left / right
#   f            fire
#   space, e     use / open door
#   enter        menu confirm
#   escape       menu / back
#   tab          automap
#   y / n        menu yes/no
#   q            quit client
while true; do
  IFS= read -r -s -n1 key < /dev/tty || break

  # Escape sequences (arrow keys = ESC [ A/B/C/D, bare ESC = menu).
  if [ "$key" = $'\x1b' ]; then
    IFS= read -r -s -n1 -t 0.05 key2 < /dev/tty
    if [ "$key2" = '[' ]; then
      IFS= read -r -s -n1 -t 0.05 key3 < /dev/tty
      case "$key3" in
        A) send_key 'w' ;;
        B) send_key 's' ;;
        C) send_key 'd' ;;
        D) send_key 'a' ;;
      esac
      continue
    fi
    send_key 'escape'
    continue
  fi

  case "$key" in
    q|Q)   cleanup ;;
    w|W)   send_key 'w' ;;
    s|S)   send_key 's' ;;
    a|A)   send_key 'a' ;;
    d|D)   send_key 'd' ;;
    ',')   send_key ',' ;;
    '.')   send_key '.' ;;
    f|F)   send_key 'f' ;;
    e|E)   send_key 'e' ;;
    ' ')   send_key ' ' ;;
    y|Y)   send_key 'y' ;;
    n|N)   send_key 'n' ;;
    '')    send_key 'enter' ;;
    $'\t') send_key 'tab' ;;
  esac
done
