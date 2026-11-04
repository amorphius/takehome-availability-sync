#!/usr/bin/env bash
# OPS-05: the one check every commit must pass. Typecheck, lint, unit and integration tests, requirement trace.
# Needs PostgreSQL on DATABASE_URL (default postgres://sync:sync@localhost:5432/sync); see service/README.md.
# Usage: scripts/gate.sh            exit 0 only when every step passed; each step's result is printed.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
status=0
step() {
  local name=$1; shift
  if "$@" > "/tmp/gate-$name.log" 2>&1; then
    printf '%-10s ok\n' "$name"
  else
    printf '%-10s FAILED (see /tmp/gate-%s.log)\n' "$name" "$name"
    tail -n 30 "/tmp/gate-$name.log"
    status=1
  fi
}
step typecheck npm --prefix service run typecheck
step lint      npm --prefix service run lint
step unit      npm --prefix service run test:unit
step fake      npm --prefix service run test:fake
step trace     scripts/trace.sh
exit $status
