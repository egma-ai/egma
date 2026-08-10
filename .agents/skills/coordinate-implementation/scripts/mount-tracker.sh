#!/usr/bin/env bash
# Mount the issue tracker into a worktree, and prove it landed.
#
# A worktree carries tracked files only. A tracker that lives in a separate
# repo is therefore absent from every fresh one, and nothing reports the
# absence — the agent just works without its ticket. This script closes that
# hole and fails loudly when it cannot.
#
# Usage:
#   bash mount-tracker.sh --tracker <repo> --into <worktree> [options]
#   bash mount-tracker.sh --remove --tracker <repo> --into <worktree> [--at <dir>]
#
#   --tracker <repo>    path to the tracker repo (its own checkout)
#   --into <worktree>   the agent's worktree, already cut
#   --at <dir>          mount point inside it (default: basename of --tracker)
#   --ref <ref>         what to mount (default: origin/main)
#   --expect <relpath>  file that must exist under the mount point once done
#   --remove            unmount instead, and prune
#
# Mounting is detached on purpose. A branch can be checked out in one worktree
# only, so the second agent asking for main is refused outright; detached, any
# number of agents hold their own copy at the same commit. The flip side is
# that a commit made in a mounted copy is unreachable once the worktree goes —
# agents read the tracker, the coordinator writes it.
#
# Rerunning is safe and always converges on --ref: a mount already at that
# commit is kept, anything else is replaced. Nothing is ever left half-mounted,
# so a retry after a failure starts clean rather than inheriting a wrong commit.

set -euo pipefail

die() { printf 'mount-tracker: %s\n' "$1" >&2; exit 1; }

tracker="" into="" at="" ref="origin/main" expect="" remove=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tracker) tracker="${2:-}"; shift 2 ;;
    --into)    into="${2:-}";    shift 2 ;;
    --at)      at="${2:-}";      shift 2 ;;
    --ref)     ref="${2:-}";     shift 2 ;;
    --expect)  expect="${2:-}";  shift 2 ;;
    --remove)  remove=1;         shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$tracker" ] || die "--tracker is required"
[ -n "$into" ]    || die "--into is required"

[ -d "$tracker" ] || die "tracker repo not found: $tracker"
git -C "$tracker" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $tracker"
tracker="$(cd "$tracker" && pwd)"

[ -d "$into" ] || die "worktree not found: $into — cut the code worktree first"
into="$(cd "$into" && pwd)"

[ -n "$at" ] || at="$(basename "$tracker")"
case "$at" in
  /*|*..*) die "--at must be a plain relative path inside the worktree: $at" ;;
esac
mount="$into/$at"

unmount() {
  [ -e "$mount" ] || return 0
  git -C "$tracker" worktree remove --force "$mount" 2>/dev/null || rm -rf "$mount"
  git -C "$tracker" worktree prune
}

if [ "$remove" -eq 1 ]; then
  unmount
  printf 'mount-tracker: unmounted %s\n' "$mount"
  exit 0
fi

# Drop registrations whose directory was deleted by hand, or the add below
# fails on a path git still believes it owns.
git -C "$tracker" worktree prune

if ! git -C "$tracker" fetch origin >/dev/null 2>&1; then
  printf 'mount-tracker: WARNING could not fetch %s — using the local ref, which may be behind\n' \
    "$tracker" >&2
fi

target="$(git -C "$tracker" rev-parse --verify --quiet "$ref^{commit}")" \
  || die "ref not found in $tracker: $ref"

# Resolve the target before looking at what is already there, so a mount left
# at a stale commit is replaced rather than silently accepted.
if [ -d "$mount" ] && [ -n "$(ls -A "$mount" 2>/dev/null)" ]; then
  current="$(git -C "$mount" rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$current" = "$target" ]; then
    kept=1
  else
    printf 'mount-tracker: replacing mount at %s (was %s)\n' "$mount" "${current:0:7}" >&2
    unmount
  fi
fi

if [ -z "${kept:-}" ]; then
  mkdir -p "$(dirname "$mount")"
  git -C "$tracker" worktree add --detach "$mount" "$target" >/dev/null \
    || die "could not mount $ref at $mount"
fi

# Prove it, rather than trusting that the command above did what it said.
[ -d "$mount" ] && [ -n "$(ls -A "$mount" 2>/dev/null)" ] \
  || die "mount point is missing or empty after mounting: $mount"

if [ -n "$expect" ] && [ ! -e "$mount/$expect" ]; then
  unmount
  die "mounted $ref, but $expect is not there — wrong ref or wrong repo? unmounted again"
fi

printf 'mount-tracker: %s @ %s -> %s%s\n' \
  "$ref" "$(git -C "$mount" rev-parse --short HEAD)" "$mount" \
  "$([ -n "${kept:-}" ] && echo ' (already current)' || true)"
