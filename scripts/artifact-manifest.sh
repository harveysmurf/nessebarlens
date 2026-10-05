#!/usr/bin/env bash
# Record or verify the content of a built .open-next/ tree.
#
# #200 builds once per environment and ships the tree between jobs as a GitHub
# artifact, which is a zip round-trip. That is a real boundary: the deploy job
# trusts a tree it did not build, and "the artifact was uploaded" says nothing
# about what is in it. This is the check on the far side of that boundary.
#
#   artifact-manifest.sh write <dir> <out-file>   record the tree
#   artifact-manifest.sh check <dir> <manifest>   recompute and diff
#
# What the manifest covers is paths and content hashes, and that is deliberate
# rather than convenient:
#
#   * symlinks are refused at write time. actions/upload-artifact stores files,
#     so a symlink would be silently dereferenced and the deploy would run
#     against a different tree than the one that was tested. Measured on this
#     repo: .open-next/ has none, so this is a standing check rather than a
#     claim about today's build.
#   * file modes are not covered. upload-artifact does not preserve them and
#     nothing in the deploy path needs them: wrangler reads worker.js and the
#     asset tree, it does not execute anything. Measured on this repo, the only
#     executable file under .open-next/ is a nested postcss package.json, which
#     is content rather than behaviour. Pinning modes here would assert
#     something the artifact cannot carry.
#
# The manifest is sorted and sha256-per-file so the diff is stable across
# machines: `find` order is filesystem-dependent, and an unstable manifest
# makes every check look like a change.
set -euo pipefail

usage() {
  echo "usage: artifact-manifest.sh write <dir> <out> | check <dir> <manifest>" >&2
  exit 2
}

emit() {
  local dir="$1" manifest="${2:-}"
  # The manifest is written *inside* the tree on purpose -- it has to travel
  # with the artifact, or the deploy job could be handed a manifest from a
  # different build than the tree it downloaded. That means the manifest is
  # itself one of the files `find` returns at `check` time and was not there at
  # `write` time, so hashing it would make every check report a difference
  # against itself. Excluded by absolute path, compared as a string, because
  # `find` prints the dir it was given and the caller passes the same one.
  #
  # LC_ALL=C so the sort order does not depend on the runner's locale.
  LC_ALL=C find "$dir" -type f \
    ! -path "$manifest" -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 -r sha256sum
}

command="${1:-}"
[ -n "$command" ] || usage
shift

case "$command" in
  write)
    dir="${1:-}"; out="${2:-}"
    [ -n "$dir" ] && [ -n "$out" ] || usage
    [ -d "$dir" ] || { echo "artifact-manifest: $dir is not a directory" >&2; exit 1; }

    # Refuse before writing, not after: a manifest that recorded a dereferenced
    # symlink would be a green check on a tree that is not the built one.
    links="$(find "$dir" -type l -print)"
    if [ -n "$links" ]; then
      echo "artifact-manifest: $dir contains symlinks, which an artifact round-trip dereferences:" >&2
      printf '%s\n' "$links" | sed 's/^/  /' >&2
      exit 1
    fi

    # Same exclusion as emit(), so the count reported here is the number of
    # lines the manifest will have -- not off by the manifest itself on a
    # re-write.
    count="$(find "$dir" -type f ! -path "$out" | wc -l | tr -d ' ')"
    [ "$count" -gt 0 ] || { echo "artifact-manifest: $dir has no files" >&2; exit 1; }

    emit "$dir" "$out" > "$out"
    echo "artifact-manifest: recorded $count files from $dir"
    ;;
  check)
    dir="${1:-}"; manifest="${2:-}"
    [ -n "$dir" ] && [ -n "$manifest" ] || usage
    [ -d "$dir" ] || { echo "artifact-manifest: $dir is not a directory" >&2; exit 1; }
    [ -f "$manifest" ] || { echo "artifact-manifest: no manifest at $manifest" >&2; exit 1; }

    links="$(find "$dir" -type l -print)"
    if [ -n "$links" ]; then
      echo "artifact-manifest: $dir contains symlinks, which an artifact round-trip dereferences:" >&2
      printf '%s\n' "$links" | sed 's/^/  /' >&2
      exit 1
    fi

    actual="$(mktemp)"
    trap 'rm -f "$actual"' EXIT
    emit "$dir" "$manifest" > "$actual"

    if ! diff -u "$manifest" "$actual"; then
      echo "" >&2
      echo "artifact-manifest: $dir does not match the manifest recorded at build time." >&2
      echo "artifact-manifest: the artifact round-trip changed the tree, so this deploy" >&2
      echo "artifact-manifest: would ship something other than what was built." >&2
      exit 1
    fi
    echo "artifact-manifest: $dir matches the build-time manifest ($(wc -l < "$actual" | tr -d ' ') files)"
    ;;
  *)
    usage
    ;;
esac