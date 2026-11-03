#!/usr/bin/env bash
# OPS-04: for every requirement ID in SPEC.md, the commits and test files that name it.
# Usage: scripts/trace.sh            (run from anywhere inside the repository)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

ids=$(grep -oE '^\| (DATA|API|SYNC|OBS|OPS)-[0-9]{2} ' SPEC.md | tr -d '| ')
missing=0
printf '%-9s %-8s %-9s %s\n' ID VERIFIED COMMITS TESTS
for id in $ids; do
  verified=$(grep -E "^\| $id " SPEC.md | awk -F'|' '{gsub(/^ +| +$/, "", $4); print $4}')
  # IDs live in square brackets in the subject: "[SYNC-02 SYNC-03]"; match the ID bounded by a bracket or space.
  commits=$(git log --format='%h' --extended-regexp --grep="[[ ]$id[] ]" | tr '\n' ' ')
  tests=$(grep -rlE "(^|[^A-Z0-9-])$id([^0-9]|$)" service/test 2>/dev/null | sed 's#service/test/##' | tr '\n' ' ' || true)
  flag=""
  if [ -z "$commits" ]; then flag=" <- no commit"; missing=1; fi
  if [ -z "$tests" ] && [ "$verified" != "manual" ]; then flag="$flag <- no test"; missing=1; fi
  printf '%-9s %-8s %-9s %s%s\n' "$id" "$verified" "${commits:--}" "${tests:--}" "$flag"
done
exit $missing
