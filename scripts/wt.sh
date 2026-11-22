#!/bin/sh
# Creates a worktree for one task, ready to work in: a new branch from origin/main in
# <repo>.wt/<name>, with the dependencies installed.
#
#   scripts/wt.sh <name> [branch]      branch defaults to <name>
#
# The main checkout stays on main and clean; every task lives in its own worktree so several can run in parallel.
# Do not start the sandbox (.sandbox/) or bind the web port from a worktree: they belong to the main checkout.
set -eu

name=${1:?usage: scripts/wt.sh <name> [branch]}
branch=${2:-$name}

common=$(git rev-parse --path-format=absolute --git-common-dir)
root=$(dirname "$common")
dest="$root.wt/$name"

[ ! -e "$dest" ] || { echo "$dest already exists" >&2; exit 1; }

git -C "$root" fetch --quiet origin main
git -C "$root" worktree add -b "$branch" "$dest" origin/main
(cd "$dest" && npm ci --no-audit --no-fund)
echo "Ready: $dest (branch $branch)"
