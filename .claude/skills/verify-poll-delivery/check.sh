#!/usr/bin/env bash
# Model-check PollDelivery.tla with TLC, one run per config, and compare each result with the expected one.
# Usage: .claude/skills/verify-poll-delivery/check.sh [NAME.cfg ...]   (default: every .cfg here)
# Exit 0: every result as expected. 1: a result changed. 2: the tools could not run.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$dir" rev-parse --show-toplevel)
cache="$root/node_modules/.cache/verify-poll-delivery"
jar="$cache/tla2tools-1.7.4.jar"
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

# What each config gives at the sync commit: "holds", or the rule a known finding breaks (see SKILL.md).
expected() {
  case "$1" in
    NoOverlap | Overlap) echo holds ;;
    OverlapFirstDeploy) echo NoSilentSkip ;;
    NoDuplicate) echo NoDuplicate ;;
    *) echo unknown ;;
  esac
}

command -v java >/dev/null || { echo "needs Java 11 or later on PATH"; exit 2; }
mkdir -p "$cache"
if ! [ -f "$jar" ] || [ "$(shasum -a 256 "$jar" | cut -d' ' -f1)" != "$sha" ]; then
  curl -fsSL -o "$jar.tmp" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar || { echo "could not download tla2tools.jar"; exit 2; }
  [ "$(shasum -a 256 "$jar.tmp" | cut -d' ' -f1)" = "$sha" ] || { echo "tla2tools.jar checksum mismatch"; rm -f "$jar.tmp"; exit 2; }
  mv "$jar.tmp" "$jar"
fi

sync=$(grep -o 'Sync commit: `[0-9a-f]*`' "$dir/SKILL.md" | grep -o '[0-9a-f]\{7,\}')
covered=$(grep '^| `src/' "$dir/SKILL.md" | grep -o 'src/[a-z/.]*\.ts' | sort -u) # the coverage table's files
# shellcheck disable=SC2086 # one path per word
changed=$(git -C "$root" diff --name-only "$sync" -- $covered)
[ -z "$changed" ] || printf 'Covered code changed since the sync commit %s; check that the model still describes it:\n%s\n\n' "$sync" "$changed"

cfgs=("$@")
[ ${#cfgs[@]} -gt 0 ] || cfgs=("$dir"/*.cfg)
status=0
for cfg in "${cfgs[@]}"; do
  name=$(basename "$cfg" .cfg)
  out="$cache/$name.out"
  (cd "$dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -metadir "$cache/states/$name" \
    -config "$name.cfg" PollDelivery.tla >"$out" 2>&1) || true
  if grep -q 'No error has been found' "$out"; then got=holds
  elif grep -q 'Invariant .* is violated' "$out"; then got=$(sed -n 's/.*Invariant \(.*\) is violated.*/\1/p' "$out" | head -1)
  else got=error; fi
  want=$(expected "$name")
  if [ "$got" = "$want" ]; then mark=ok; else mark=CHANGED; status=1; fi
  printf '%-20s %-8s %-14s expected %-14s %s\n' "$name" "$mark" "$got" "$want" "$out"
done
exit $status
