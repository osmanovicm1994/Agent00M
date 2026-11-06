#!/usr/bin/env bash
# Safe npm dependency updates: one package at a time, checks after each, commit on green, roll back on red.
# Usage: bash scripts/deps-update.sh [project-dir] [--level patch|minor|major] [--pkg name]... [--no-commit] [--allow-dirty]
#   patch (default): only 1.2.3 -> 1.2.x      minor: 1.2.3 -> 1.x.y (within the package.json range)
#   major: only for packages named with --pkg (read the release notes first)
# Other ecosystems (Gradle, Maven, pip, .NET, Pods): see src/knowledge/14-coding/05-dependency-updates.md
set -u
DIR="."; LEVEL="patch"; PKGS=(); COMMIT=1; DIRTY=0
args=("$@"); i=0
while [ $i -lt ${#args[@]} ]; do
  a="${args[$i]}"
  case "$a" in
    --level) i=$((i+1)); LEVEL="${args[$i]:-patch}" ;;
    --pkg) i=$((i+1)); PKGS+=("${args[$i]:-}") ;;
    --no-commit) COMMIT=0 ;;
    --allow-dirty) DIRTY=1 ;;
    -*) echo "Unknown option: $a"; exit 2 ;;
    *) DIR="$a" ;;
  esac
  i=$((i+1))
done
case "$LEVEL" in patch|minor|major) ;; *) echo "--level must be patch, minor or major"; exit 2 ;; esac
if [ "$LEVEL" = "major" ] && [ ${#PKGS[@]} -eq 0 ]; then echo "A major update needs --pkg <name> (one named package)."; exit 2; fi

cd "$DIR" 2>/dev/null || { echo "Folder not found: $DIR"; exit 2; }
[ -f package.json ] || { echo "No package.json here."; exit 2; }
[ -f package-lock.json ] || { echo "Only npm projects (package-lock.json) are automated. See 14-coding/05-dependency-updates.md."; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a git repository: updates need git to roll back."; exit 2; }
if [ "$DIRTY" = 0 ] && [ -n "$(git status --porcelain)" ]; then echo "The git tree has uncommitted changes. Commit or stash them first (or --allow-dirty)."; exit 2; fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$COMMIT" = 1 ] && { [ "$branch" = "main" ] || [ "$branch" = "master" ]; }; then
  nb="chore/deps-$(date +%Y%m%d)"; n=1
  while git show-ref --verify --quiet "refs/heads/$nb"; do n=$((n+1)); nb="chore/deps-$(date +%Y%m%d)-$n"; done
  git checkout -b "$nb" >/dev/null 2>&1 || { echo "Could not create branch $nb"; exit 2; }
  echo "Working on branch $nb (not on $branch)."
fi

has_script() { node -e 'const p=require(process.cwd()+"/package.json");const s=(p.scripts||{})[process.argv[1]];process.exit(s&&!/no test specified/.test(s)?0:1)' "$1"; }
verify() {
  for s in typecheck lint test build; do
    if has_script "$s"; then
      echo "   check: npm run $s"
      if [ "$s" = "test" ]; then CI=1 npm test >/tmp/deps-update.log 2>&1 || { tail -15 /tmp/deps-update.log; return 1; }
      else npm run "$s" >/tmp/deps-update.log 2>&1 || { tail -15 /tmp/deps-update.log; return 1; }; fi
    fi
  done
  return 0
}

echo "Baseline checks before any change ..."
verify || { echo "The project fails its own checks BEFORE the update. Fix that first; updates would hide the cause."; exit 1; }

list="$(npm outdated --json 2>/dev/null || true)"
[ -z "$list" ] && list="{}"
cands="$(printf '%s' "$list" | LEVEL="$LEVEL" PKGS="${PKGS[*]:-}" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 const o=JSON.parse(s||"{}"), level=process.env.LEVEL, want=(process.env.PKGS||"").split(" ").filter(Boolean);
 const mm=v=>String(v).split(".").slice(0,2).join("."), mj=v=>String(v).split(".")[0];
 for(const [name,i] of Object.entries(o)){
  if(want.length && !want.includes(name)) continue;
  if(!i.current) continue;
  let t=null;
  if(level==="major") t=i.latest;
  else if(level==="minor" && i.wanted && mj(i.wanted)===mj(i.current)) t=i.wanted;
  else if(level==="patch" && i.wanted && mm(i.wanted)===mm(i.current)) t=i.wanted;
  if(t && t!==i.current) console.log([name,i.current,t].join(" "));
 }})')"

if [ -z "$cands" ]; then echo "Nothing to update at level $LEVEL."; exit 0; fi
ok=(); bad=()
while read -r name cur target; do
  [ -z "$name" ] && continue
  echo "-> $name $cur -> $target"
  if ! npm install "$name@$target" >/tmp/deps-update.log 2>&1; then
    tail -5 /tmp/deps-update.log; echo "   install failed, rolled back"
    git checkout -- package.json package-lock.json; npm ci >/dev/null 2>&1; bad+=("$name (install failed)"); continue
  fi
  if verify; then
    ok+=("$name $cur -> $target")
    [ "$COMMIT" = 1 ] && { git add package.json package-lock.json; git commit -q -m "chore(deps): update $name $cur -> $target"; }
  else
    echo "   checks failed, rolled back"
    git checkout -- package.json package-lock.json; npm ci >/dev/null 2>&1; bad+=("$name $cur -> $target (checks failed)")
  fi
done <<< "$cands"

echo; echo "== Result =="
echo "Updated: ${#ok[@]}"; for x in "${ok[@]:-}"; do [ -n "$x" ] && echo "  + $x"; done
echo "Rolled back: ${#bad[@]}"; for x in "${bad[@]:-}"; do [ -n "$x" ] && echo "  - $x"; done
echo "Still outdated (majors need a decision): npm outdated"
[ ${#bad[@]} -eq 0 ] && exit 0 || exit 1
