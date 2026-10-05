#!/usr/bin/env bash
# Assert that a downloaded .open-next/ tree was built for one environment and
# not the other.
#
# #200 builds once per environment in a matrix and each deploy job downloads its
# own artifact by name. That makes a swapped artifact name the failure mode worth
# defending against: the staging build carries https://staging.nessebarlens.com in
# its prerendered canonicals and og:url, and the production build carries
# https://nessebarlens.com. Deploying the wrong one ships a live site whose
# canonical URL and social previews name the other hostname.
#
#   assert-artifact-origin.sh <dir> <expected-origin> <forbidden-origin>
#
# Both directions are checked on purpose. Finding the expected origin alone would
# pass an artifact that somehow contained both, and the failure this guards is
# exactly the one where somebody edited a matrix leg and left a stale variable
# lying around next to a correct one.
set -euo pipefail

DIR="${1:-}"
EXPECTED="${2:-}"
FORBIDDEN="${3:-}"

if [ -z "$DIR" ] || [ -z "$EXPECTED" ] || [ -z "$FORBIDDEN" ]; then
  echo "usage: assert-artifact-origin.sh <dir> <expected-origin> <forbidden-origin>" >&2
  exit 2
fi
if [ ! -d "$DIR" ]; then
  echo "assert-artifact-origin: $DIR is not a directory" >&2
  exit 1
fi

fail() {
  echo "assert-artifact-origin: $1" >&2
  exit 1
}

# `grep -c`-style counting without trusting grep's exit status. `grep -rl`
# exits 1 when it matches nothing, which under `set -e` + `pipefail` would abort
# the script on the *passing* path -- a correctly built staging artifact has
# zero production references, so the check that is supposed to make the job
# green is the one that turns it red. `|| true` makes the count, not the
# status, the thing being asserted.
count_files() {
  local needle="$1" dir="$2"
  grep -rlF -- "$needle" "$dir" 2>/dev/null | wc -l | tr -d ' ' || true
}

found_expected="$(count_files "$EXPECTED" "$DIR")"
[ "$found_expected" -gt 0 ] ||
  fail "$DIR carries no reference to $EXPECTED. It was built for the other environment, or the build-time variable was empty."

found_forbidden="$(count_files "$FORBIDDEN" "$DIR")"
[ "$found_forbidden" -eq 0 ] ||
  fail "$DIR references $FORBIDDEN in $found_forbidden files, so it was built for the other environment. Deploying it would publish the wrong origin."

echo "assert-artifact-origin: $DIR is built for $EXPECTED ($found_expected files reference it, 0 reference $FORBIDDEN)"