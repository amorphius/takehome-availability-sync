#!/usr/bin/env bash
# OPS-05: a commit that changes behaviour names the requirement it implements.
#   feat, fix, perf and test subjects must end with "[ID ...]"; docs, chore, ci, build, refactor and style may.
#   Every ID named must exist in SPEC.md. The subject starts with a conventional type.
# Usage: scripts/check-commit-msg.sh <message-file>      as a commit-msg hook (cp into .git/hooks/commit-msg)
#        scripts/check-commit-msg.sh --range <A>..<B>    every commit in the range, for CI
set -uo pipefail
root=$(git rev-parse --show-toplevel)
ids_re='(DATA|API|SYNC|OBS|OPS|SEC)-[0-9]{2}'
types='feat|fix|perf|test|docs|chore|ci|build|refactor|style'
needs_id='feat|fix|perf|test'
conventional_re="^($types)(\\([^)]+\\))?!?: .+"
bracket_re='\[([^]]*)\]$'

check() {
  local subject=$1 problems=0
  if ! [[ $subject =~ $conventional_re ]]; then
    echo "  not conventional: \"$subject\""; return 1
  fi
  local type=${BASH_REMATCH[1]}
  if [[ $subject =~ $bracket_re ]]; then
    local list=${BASH_REMATCH[1]} id
    for id in $list; do
      if ! [[ $id =~ ^$ids_re$ ]]; then echo "  malformed ID \"$id\" in: \"$subject\""; problems=1; continue; fi
      grep -qE "^\| $id " "$root/SPEC.md" || { echo "  unknown requirement $id in: \"$subject\""; problems=1; }
    done
  elif [[ $type =~ ^($needs_id)$ ]]; then
    echo "  $type commit without a requirement ID: \"$subject\""; problems=1
  fi
  return $problems
}

if [[ ${1:-} == --range ]]; then
  failed=0
  while IFS= read -r subject; do
    check "$subject" || failed=1
  done < <(git log --reverse --format='%s' "$2")
  [[ $failed -eq 0 ]] && echo "commit messages ok: $(git rev-list --count "$2") commits"
  exit $failed
else
  subject=$(head -n 1 "$1")
  check "$subject" && exit 0
  echo "commit refused; see scripts/check-commit-msg.sh" >&2
  exit 1
fi
