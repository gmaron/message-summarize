#!/bin/sh
# PreToolUse (Bash): refuses git commit/push while the branch of the repository the command works in is main.
#
# It is a guard against committing to main by accident, not a defence against a command written to get around it. It
# follows the directory of each git commit/push of the command (`cd <dir> && git commit`, `git -C <dir> commit`, else
# the working directory of the session), so a worktree is judged by its own branch and not by the main checkout, where
# the hook runs from ($CLAUDE_PROJECT_DIR). It fails closed: a commit/push whose directory or branch cannot be told
# (a variable or a substitution in the path, a directory that does not exist yet, --git-dir, --work-tree, no branch)
# is refused too. Every commit/push of the command is judged, not only the last one.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$cwd" ] || cwd=$(pwd)

# Any `git` word followed, after any words, by commit or push (so `git -c x=y commit` and `git  push` count too).
git_re='(^|[^[:alnum:]_./-])git([[:space:]]+[^[:space:]]+)*[[:space:]]+(commit|push)([^[:alnum:]_-]|$)'
printf '%s' "$cmd" | grep -Eq "$git_re" || exit 0

unquote() { sed -E "s/^[\"']//; s/[\"']\$//"; }
home_of() { case "$1" in "~"*) printf '%s' "$HOME${1#"~"}" ;; *) printf '%s' "$1" ;; esac; }
# The directory $2 reaches from $1, or nothing when it cannot be told.
reach() {
  case "$2" in '' | - | *'$'* | *'`'*) return 1 ;; esac
  (cd "$1" 2>/dev/null && cd "$(home_of "$2")" 2>/dev/null && pwd)
}
block() {
  echo "Blocked: $1" >&2
  exit 2
}

# One simple command per line: split at ; & | ( ) { } and backticks (a newline already separates), but not inside quotes:
# there those characters are first replaced by \001, so a commit message with a ; or a (...) stays in one piece. A path
# that holds \001 cannot be followed, which refuses the command.
dir=$cwd
unknown=
printf '%s\n' "$cmd" |
  awk -v sq="'" '{
    out = ""; q = ""
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (q == "") { if (c == "\"" || c == sq) q = c }
      else if (c == q) q = ""
      else if (index(";&|(){}`", c) > 0) c = "\001"
      out = out c
    }
    print out
  }' | tr ';&|(){}`' '\n' | {
  while IFS= read -r seg; do
    seg=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//')
    case "$seg" in
      cd | "cd "* | "cd	"*)
        target=$(printf '%s' "${seg#cd}" | sed -E 's/^[[:space:]]+//; s/[[:space:]].*$//' | unquote)
        if next=$(reach "$dir" "$target") && [ -n "$next" ]; then dir=$next; else unknown=1; fi
        continue
        ;;
    esac
    printf '%s' "$seg" | grep -Eq "$git_re" || continue
    # A commit or push: where does it work, and on which branch?
    # Outside quotes only: a commit message may name those options without using them.
    printf '%s' "$seg" | sed -E "s/\"[^\"]*\"//g; s/'[^']*'//g" | grep -Eq -- '--git-dir|--work-tree|GIT_DIR=|GIT_WORK_TREE=' &&
      block "a git commit/push that sets its own git directory cannot be checked. Run it from the repository on a branch."
    [ -z "$unknown" ] || block "cannot tell which directory a git commit/push works in (a cd the guard cannot follow). Use a plain path."
    target=$dir
    # `-C` is an option of git itself: only what comes before the subcommand counts, not a message that names it.
    before=$(printf '%s' "$seg" | sed -E 's/[[:space:]](commit|push)([[:space:]]|$).*//')
    c_dir=$(printf '%s' "$before" | grep -Eo -- '-C[[:space:]]+("[^"]+"|'"'"'[^'"'"']+'"'"'|[^[:space:]]+)' | tail -1 | sed -E 's/^-C[[:space:]]+//' | unquote)
    if [ -n "$c_dir" ]; then
      target=$(reach "$dir" "$c_dir") && [ -n "$target" ] ||
        block "cannot tell which directory '$c_dir' of a git commit/push is. Use a plain, existing path."
    fi
    branch=$(git -C "$target" rev-parse --abbrev-ref HEAD 2>/dev/null)
    [ -n "$branch" ] || block "cannot tell the branch of $target for a git commit/push."
    [ "$branch" != main ] || block "you are on main. Create a branch first."
  done
  exit 0
}
