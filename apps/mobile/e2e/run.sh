#!/usr/bin/env bash
# Run the Maestro suite against the iOS simulator dev client.
#
#   npm run e2e                 # every flow in e2e/*.yaml
#   npm run e2e -- login team   # only these flows (basename, .yaml optional)
#
# Environment
#   SIM_UDID      simulator to drive (default: the project's iPhone dev sim)
#   METRO_PORT    Metro/Expo dev-server port the dev client is bound to (8081)
#   API_ORIGIN    backend the app talks to; only probed, never started (http://127.0.0.1:3003)
#   E2E_OUT       where per-flow logs and the summary land (default: $TMPDIR/thestoro-e2e/<stamp>)
#   MAESTRO       maestro binary (default: ~/.maestro/bin/maestro, else PATH)
#   E2E_TIMEOUT   per-flow wall clock in seconds (default 600) — enforced via
#                 timeout/gtimeout when present, else a perl watchdog (macOS)
#
# What it guarantees
#   • the simulator is booted before the first flow
#   • Metro is up: reuses a running dev server on METRO_PORT, otherwise starts
#     `expo start --dev-client` in the background and stops it again on exit
#   • every flow runs even after a failure; the summary lists PASS/FAIL per flow
#   • exit code 1 when any flow failed, 2 when the suite could not start
#
# Flows live in e2e/*.yaml; e2e/helpers/*.yaml are fragments (runFlow targets)
# and are never run on their own. Flow files are run alphabetically; login.yaml
# is independent (every flow signs itself in when it lands on the login screen).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"

SIM_UDID="${SIM_UDID:-AB3575BB-3B9D-4D66-85AD-DA2FA5C2F34B}"
METRO_PORT="${METRO_PORT:-8081}"
API_ORIGIN="${API_ORIGIN:-http://127.0.0.1:3003}"
E2E_TIMEOUT="${E2E_TIMEOUT:-600}"
STAMP="$(date +%Y%m%d-%H%M%S)"
E2E_OUT="${E2E_OUT:-${TMPDIR:-/tmp}/thestoro-e2e/$STAMP}"
mkdir -p "$E2E_OUT"

if [ -n "${MAESTRO:-}" ]; then
  :
elif [ -x "$HOME/.maestro/bin/maestro" ]; then
  MAESTRO="$HOME/.maestro/bin/maestro"
elif command -v maestro >/dev/null 2>&1; then
  MAESTRO="$(command -v maestro)"
else
  echo "e2e: maestro not found (install: curl -Ls https://get.maestro.mobile.dev | bash)" >&2
  exit 2
fi

log() { printf '%s e2e: %s\n' "$(date +%H:%M:%S)" "$*"; }

# ---- simulator --------------------------------------------------------------
if ! xcrun simctl list devices 2>/dev/null | grep -q "$SIM_UDID"; then
  echo "e2e: simulator $SIM_UDID is not in 'xcrun simctl list devices' — set SIM_UDID" >&2
  exit 2
fi
if ! xcrun simctl list devices booted 2>/dev/null | grep -q "$SIM_UDID"; then
  log "booting simulator $SIM_UDID"
  xcrun simctl boot "$SIM_UDID" >/dev/null 2>&1 || true
fi
# -b blocks until the boot completes (no-op when already booted).
xcrun simctl bootstatus "$SIM_UDID" -b >/dev/null 2>&1 || true
if ! xcrun simctl listapps "$SIM_UDID" 2>/dev/null | grep -q '"com.thestoro.app"'; then
  echo "e2e: com.thestoro.app is not installed on $SIM_UDID — run 'npm run ios:sim' first" >&2
  exit 2
fi
log "simulator $SIM_UDID booted, dev client installed"

# ---- backend (probe only) ---------------------------------------------------
if curl -s -m 3 -o /dev/null "$API_ORIGIN/api/v1/me"; then
  log "backend answering at $API_ORIGIN"
else
  log "WARNING: nothing answers at $API_ORIGIN — flows that sign in will fail"
fi

# ---- metro ------------------------------------------------------------------
METRO_PID=""
metro_up() { curl -s -m 2 "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null | grep -q 'packager-status:running'; }
cleanup() {
  if [ -n "$METRO_PID" ]; then
    log "stopping the Metro we started (pid $METRO_PID)"
    # The subshell was spawned under job control (set -m below), so its pid IS
    # its process-group id and the group kill takes `npx expo start` and the
    # node packager down with it. Then a belt-and-braces pass over the direct
    # children and the wrapper itself, in case the group kill was refused.
    kill -TERM -- -"$METRO_PID" >/dev/null 2>&1 || true
    pkill -TERM -P "$METRO_PID" >/dev/null 2>&1 || true
    kill -TERM "$METRO_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# `timeout` is GNU coreutils; macOS ships none (brew's is `gtimeout`). Without
# one, fall back to a perl watchdog that mirrors GNU timeout: run the command
# in its own process group, TERM the whole group on expiry (KILL 3s later),
# exit 124 — so E2E_TIMEOUT is honoured on the primary dev platform too.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v perl >/dev/null 2>&1; then
  TIMEOUT_BIN="perl"
  log "no timeout/gtimeout on PATH — using a perl watchdog for E2E_TIMEOUT=${E2E_TIMEOUT}s"
else
  echo "e2e: WARNING — no timeout, gtimeout or perl on PATH; E2E_TIMEOUT is NOT enforced and a hung flow blocks the suite" >&2
fi
run_with_timeout() {  # run_with_timeout SECONDS cmd args…
  local secs="$1"; shift
  case "$TIMEOUT_BIN" in
    timeout|gtimeout) "$TIMEOUT_BIN" "$secs" "$@" ;;
    perl)
      perl -e '
        my $secs = shift;
        my $pid = fork;
        die "fork: $!" unless defined $pid;
        if ($pid == 0) { setpgrp(0, 0); exec @ARGV; exit 127 }
        $SIG{ALRM} = sub {
          kill TERM => -$pid;
          for (1..30) { last if waitpid($pid, 1) != 0; select undef, undef, undef, 0.1 }
          kill KILL => -$pid; waitpid $pid, 0; exit 124;
        };
        alarm $secs;
        waitpid $pid, 0;
        alarm 0;
        exit(($? & 127) ? 128 + ($? & 127) : $? >> 8);
      ' "$secs" "$@" ;;
    *) "$@" ;;
  esac
}

if metro_up; then
  log "Metro already running on :$METRO_PORT"
else
  log "starting Metro on :$METRO_PORT (log: $E2E_OUT/metro.log)"
  # Job control on for the spawn only: the subshell then leads its own process
  # group, which is what lets cleanup() kill the whole `expo start` tree.
  set -m
  (
    cd "$APP_DIR" || exit 1
    CI=1 EXPO_NO_TELEMETRY=1 npx expo start --dev-client --port "$METRO_PORT" >"$E2E_OUT/metro.log" 2>&1 </dev/null
  ) &
  METRO_PID=$!
  set +m
  for _ in $(seq 1 90); do
    if metro_up; then break; fi
    if ! kill -0 "$METRO_PID" >/dev/null 2>&1; then
      echo "e2e: Metro exited early — see $E2E_OUT/metro.log" >&2
      exit 2
    fi
    sleep 2
  done
  if ! metro_up; then
    echo "e2e: Metro did not come up on :$METRO_PORT within 180s — see $E2E_OUT/metro.log" >&2
    exit 2
  fi
  log "Metro is up"
fi

# ---- flows ------------------------------------------------------------------
cd "$HERE" || exit 2
FLOWS=()
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    f="${arg%.yaml}.yaml"
    f="${f##*/}"
    if [ -f "$f" ]; then FLOWS+=("$f"); else echo "e2e: no such flow: $arg" >&2; exit 2; fi
  done
else
  for f in *.yaml; do FLOWS+=("$f"); done
fi
if [ "${#FLOWS[@]}" -eq 0 ]; then
  echo "e2e: no flows found in $HERE" >&2
  exit 2
fi

pass=0; fail=0
results=()
suite_start=$(date +%s)
for flow in "${FLOWS[@]}"; do
  name="${flow%.yaml}"
  logf="$E2E_OUT/$name.log"
  log "▶ $name"
  start=$(date +%s)
  run_with_timeout "$E2E_TIMEOUT" "$MAESTRO" --device "$SIM_UDID" test \
    --format junit --output "$E2E_OUT/$name.junit.xml" "$flow" >"$logf" 2>&1
  rc=$?
  took=$(( $(date +%s) - start ))
  if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1)); results+=("PASS  ${took}s  $name")
    log "✔ $name (${took}s)"
  else
    why="exit $rc"; [ "$rc" -eq 124 ] && why="timed out after ${E2E_TIMEOUT}s"
    fail=$((fail + 1)); results+=("FAIL  ${took}s  $name  ($why, log: $logf)")
    log "✖ $name (${took}s, exit $rc)"
    # The tail of Maestro's output names the failing step; surface it inline.
    tail -n 12 "$logf" | sed 's/^/    │ /'
  fi
done

# ---- summary ----------------------------------------------------------------
total=$((pass + fail))
took=$(( $(date +%s) - suite_start ))
{
  echo
  echo "e2e summary — $total flows, $pass passed, $fail failed, ${took}s"
  echo "simulator $SIM_UDID · metro :$METRO_PORT · logs $E2E_OUT"
  printf '  %s\n' "${results[@]}"
  echo
} | tee "$E2E_OUT/summary.txt"

if [ "$fail" -gt 0 ]; then exit 1; fi
exit 0
