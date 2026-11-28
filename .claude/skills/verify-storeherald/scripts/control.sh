#!/usr/bin/env bash
# Launch, check and tear down a local storeherald Worker whose targets all post to a local capture server.
#   control.sh launch            start a new run; prints `export SH_RUN=<run-dir>`
#   control.sh doctor            read-only: is the run in $SH_RUN worth driving?
#   control.sh captured [n]      the last n (default 20) posts the capture server received, one JSON line each
#   control.sh cleanup           stop the run in $SH_RUN, delete its state and secrets, keep <run-dir>/evidence
# Runs live in $STOREHERALD_VERIFY_ROOT (default $TMPDIR/storeherald-verify), one directory per run.
set -euo pipefail

SKILL=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$SKILL" rev-parse --show-toplevel)
TMP=${TMPDIR:-/tmp}
ROOT=${STOREHERALD_VERIFY_ROOT:-${TMP%/}/storeherald-verify}
ROOT=${ROOT%/}

die() { echo "error: $*" >&2; exit 1; }
need_run() {
  [ -n "${SH_RUN:-}" ] || die 'SH_RUN is not set: run `control.sh launch` and export what it prints'
  [ -f "$SH_RUN/run.json" ] || die "$SH_RUN/run.json is missing: not a launched run"
}
field() { node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r[process.argv[2]] ?? "")' "$SH_RUN/run.json" "$1"; }

# Prints the pid in <name>.pid when that process is still the group leader we started with that command.
owned_pid() {
  local file="$SH_RUN/$1.pid" pattern=$2 pid pgid cmd
  [ -f "$file" ] || return 1
  pid=$(cat "$file")
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ') || return 1
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || return 1
  [ "$pgid" = "$pid" ] && [[ "$cmd" == *"$pattern"* ]] || return 1
  echo "$pid"
}

listener_ok() { # port, owning process group: every listener on the port is in that group
  local port=$1 group=$2 pids p
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null) || return 1
  for p in $pids; do [ "$(ps -o pgid= -p "$p" | tr -d ' ')" = "$group" ] || return 1; done
}

launch() {
  [ -x "$REPO/node_modules/.bin/wrangler" ] || die "no wrangler in $REPO/node_modules: run pnpm install --frozen-lockfile there first"
  local run="$ROOT/$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$run/evidence" "$run/state"
  touch "$run/evidence/captured.jsonl" "$run/evidence/requests.jsonl"
  export SH_RUN=$run
  trap 'echo "launch failed; cleaning up $SH_RUN" >&2; cleanup >&2 || true' ERR

  node "$SKILL/scripts/run-config.ts" prepare "$run"
  git -C "$REPO" rev-parse HEAD >"$run/evidence/revision.txt"
  git -C "$REPO" status --porcelain >>"$run/evidence/revision.txt"

  set -m # each background job leads its own process group, so cleanup can stop exactly what it started
  node "$SKILL/scripts/capture-server.ts" "$run/evidence/captured.jsonl" "$(field capturePort)" >"$run/evidence/capture.log" 2>&1 &
  echo $! >"$run/capture.pid"
  # --local and the unset credentials keep this off the Cloudflare account. --env-file skips the repo's .dev.vars and .env.
  (cd "$REPO" && exec env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID \
    -u CLOUDFLARE_INCLUDE_PROCESS_ENV -u CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV WRANGLER_SEND_METRICS=false DO_NOT_TRACK=1 \
    node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port "$(field workerPort)" --inspector-port "$(field inspectorPort)" \
      --env-file "$run/dev.env" --persist-to "$run/state" --show-interactive-dev-session=false) \
    >"$run/evidence/wrangler.log" 2>&1 &
  echo $! >"$run/wrangler.pid"
  set +m

  local url i code
  url=$(field workerUrl)
  for i in $(seq 1 120); do
    # kill -0, not owned_pid: until the subshell execs, its command line doesn't name wrangler yet
    kill -0 "$(cat "$run/wrangler.pid")" 2>/dev/null || { tail -30 "$run/evidence/wrangler.log" >&2; echo 'wrangler dev exited' >&2; false; }
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$url/health_check" || true)
    [ "$code" = 200 ] && break
    [ "$code" = 500 ] && { tail -5 "$run/evidence/wrangler.log" >&2; echo 'Worker answers 500: its config does not load' >&2; false; }
    [ "$i" = 120 ] && { tail -30 "$run/evidence/wrangler.log" >&2; echo 'Worker not healthy after 60 s' >&2; false; }
    sleep 0.5
  done
  trap - ERR
  echo "storeherald ready at $url, targets captured by $(field captureUrl)"
  echo "export SH_RUN=$run"
}

doctor() {
  need_run
  local fail=0 wpid cpid url cap
  [ -f "$SH_RUN/STOPPED" ] && die "run was cleaned up at $(cat "$SH_RUN/STOPPED"); launch a new one"
  url=$(field workerUrl); cap=$(field captureUrl)
  if wpid=$(owned_pid wrangler wrangler); then echo "ok   wrangler dev pid $wpid (our process group)"; else echo 'FAIL wrangler dev is not running from this run'; fail=1; fi
  if cpid=$(owned_pid capture capture-server.ts); then echo "ok   capture server pid $cpid"; else echo 'FAIL capture server is not running from this run'; fail=1; fi
  if [ -n "${wpid:-}" ] && listener_ok "$(field workerPort)" "$wpid"; then echo "ok   $url is served by our wrangler"; else echo "FAIL port of $url is not ours"; fail=1; fi
  if [ -n "${cpid:-}" ] && listener_ok "$(field capturePort)" "$cpid"; then echo "ok   $cap is served by our capture server"; else echo "FAIL port of $cap is not ours"; fail=1; fi
  if [ "$(curl -s -m 5 "$url/health_check" || true)" = ok ]; then echo 'ok   GET /health_check: 200 ok (config loaded)'; else echo 'FAIL GET /health_check is not 200 ok: see evidence/wrangler.log'; fail=1; fi
  if curl -s -m 5 "$cap/__health" | grep -q "\"out\":\"$SH_RUN/evidence/captured.jsonl\""; then echo 'ok   capture server logs to this run'; else echo 'FAIL capture server does not log to this run'; fail=1; fi
  node "$SKILL/scripts/run-config.ts" check "$SH_RUN" || fail=1
  if [ "$(git -C "$REPO" rev-parse HEAD)" = "$(head -1 "$SH_RUN/evidence/revision.txt")" ]; then echo "ok   HEAD is the launched revision $(git -C "$REPO" rev-parse --short HEAD)"
  else echo 'WARN HEAD moved since launch; wrangler dev hot-reloads src/, so the Worker runs the current working tree'; fi
  [ "$fail" = 0 ] || exit 1
}

captured() {
  need_run
  tail -n "${1:-20}" "$SH_RUN/evidence/captured.jsonl"
}

cleanup() {
  need_run
  local name pattern pid i
  for name in wrangler capture; do
    pattern=wrangler; [ "$name" = capture ] && pattern=capture-server.ts
    pid=$(owned_pid "$name" "$pattern") || continue
    kill -TERM -- "-$pid" 2>/dev/null || true
    for i in $(seq 1 30); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    echo "stopped $name (process group $pid)"
  done
  for name in workerPort capturePort inspectorPort; do
    pid=$(field "$name")
    [ -z "$pid" ] || ! lsof -nP -iTCP:"$pid" -sTCP:LISTEN -t >/dev/null 2>&1 || echo "WARN port $pid ($name) is still in use; it is not ours to kill" >&2
  done
  rm -rf "$SH_RUN/state" "$SH_RUN/dev.env" "$SH_RUN"/*.pid
  date -u +%FT%TZ >"$SH_RUN/STOPPED"
  echo "evidence kept in $SH_RUN/evidence"
}

case "${1:-}" in
  launch) launch ;;
  doctor) doctor ;;
  captured) shift; captured "$@" ;;
  cleanup) cleanup ;;
  *) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
