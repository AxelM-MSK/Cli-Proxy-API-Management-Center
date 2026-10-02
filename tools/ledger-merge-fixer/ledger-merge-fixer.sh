#!/bin/bash
# ledger-merge-fixer: when the fork's daily sync reports an "Upstream merge
# conflict" issue, let Hermes (merge-fixer profile, Foundry model) resolve the
# merge of upstream main into `ledger`, verify the result, and open a PR.
#
# Runs as azureuser from ledger-merge-fixer.timer. Never pushes to ledger
# directly unless AUTO_MERGE=1 in ~/.config/ledger-merge-fixer.env; by default
# a human merges the PR, which triggers the fork's release workflow.
set -euo pipefail

FORK=AxelM-MSK/Cli-Proxy-API-Management-Center
# Overridable for testing against throwaway branches.
UPSTREAM=${UPSTREAM:-https://github.com/router-for-me/Cli-Proxy-API-Management-Center.git}
UPSTREAM_REF=${UPSTREAM_REF:-main}
BRANCH=${BRANCH:-ledger}
ISSUE_TITLE=${ISSUE_TITLE:-Upstream merge conflict}
ROOT=$HOME/ledger-merge-fixer
WORK=$ROOT/work
LOG=$ROOT/logs/run-$(date -u +%Y%m%dT%H%M%SZ).log
HERMES=$HOME/.local/bin/hermes
AUTO_MERGE=0
[ -f "$HOME/.config/ledger-merge-fixer.env" ] && . "$HOME/.config/ledger-merge-fixer.env"
export GH_REPO=$FORK

mkdir -p "$ROOT/logs"
cd "$ROOT"
exec > >(tee -a "$LOG") 2>&1
find "$ROOT/logs" -name 'run-*.log' -mtime +30 -delete || true

issue=$(gh issue list --state open --search "in:title \"$ISSUE_TITLE\"" --json number --jq '.[0].number // empty')
if [ -z "$issue" ]; then
  echo "no open conflict issue; nothing to do"
  exit 0
fi
echo "conflict issue #$issue"

# Skip if a fixer PR for the current upstream head already exists.
git ls-remote "$UPSTREAM" "refs/heads/$UPSTREAM_REF" > "$ROOT/upstream-head"
upstream_sha=$(cut -f1 "$ROOT/upstream-head")
fix_branch="auto/merge-upstream-${upstream_sha:0:8}"
if gh pr list --state open --head "$fix_branch" --json number --jq '.[0].number' | grep -q .; then
  echo "PR for $fix_branch already open; waiting for review"
  exit 0
fi

rm -rf "$WORK"
gh repo clone "$FORK" "$WORK" -- --quiet --branch "$BRANCH"
cd "$WORK"
git config user.name 'Hermes merge-fixer'
git config user.email 'mso@musculoskeletalmso.com'
git remote add merge-source "$UPSTREAM"
git fetch --quiet --no-tags merge-source "$UPSTREAM_REF"

if git merge --no-edit "merge-source/$UPSTREAM_REF"; then
  echo "merged cleanly now; the scheduled sync will release it"
  gh workflow run sync-upstream.yml --ref "$BRANCH" || true
  exit 0
fi
conflicts=$(git diff --name-only --diff-filter=U)
echo "conflicted files:"; echo "$conflicts"

prompt=$(cat <<EOF
You are resolving a git merge in the repository at $WORK (a React + TypeScript
management console). Upstream main (router-for-me) is being merged into our
branch "ledger", which adds: a Ledger view on the Quota page
(src/features/quota/components/QuotaLedger.tsx, ledgerModel.ts), email masking,
a view-mode switch, and Cursor quota via a local bridge (cursorBridge.ts,
hooks/useCursorBridgeQuota.ts), plus .github/workflows/sync-upstream.yml.

Conflicted files:
$conflicts

Rules:
- Keep every upstream change AND every ledger feature. Prefer upstream's
  structure and adapt our additions to it; never drop upstream code to make a
  conflict go away.
- Locale files (src/i18n/locales/*.json) must stay valid JSON with all keys
  from both sides.
- Remove every conflict marker, then run: bun install --frozen-lockfile &&
  bun run type-check && bun test tests/quotaLedger.test.ts
  tests/cursorBridgeQuota.test.ts tests/quotaUiState.test.ts && bun run build.
  Fix what fails. Stage the resolved files with git add.
- Do NOT commit, push, change git config or remotes, or touch anything outside
  $WORK.
- Finish with a short plain-text summary: per file, what each side changed and
  how you combined them; then the verification results.
EOF
)

echo "running hermes (merge-fixer profile)"
set +e
timeout 45m "$HERMES" -p merge-fixer --in "$WORK" -t terminal,file --yolo -z "$prompt" > "$ROOT/hermes-summary.txt"
hermes_rc=$?
set -e
echo "hermes exit $hermes_rc"

fail() {
  echo "FAILED: $1"
  gh issue comment "$issue" --body "$(printf 'Hermes could not resolve the merge automatically: %s\n\nHermes summary:\n\n```\n%s\n```' "$1" "$(tail -c 6000 "$ROOT/hermes-summary.txt")")" || true
  exit 1
}

# Independent verification: never trust the agent's own report.
[ "$hermes_rc" -eq 0 ] || fail "hermes exited $hermes_rc"
git add -A
[ -z "$(git diff --cached --name-only --diff-filter=U)" ] || fail "unmerged paths remain"
if git grep -nE '^(<<<<<<<|>>>>>>>)( |$)|^=======$' -- . ':!*.md' >/dev/null; then fail "conflict markers remain"; fi
for f in src/i18n/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || fail "invalid JSON in $f"; done
bun install --frozen-lockfile >/dev/null || fail "bun install failed"
bun run type-check || fail "type-check failed"
bun test tests/quotaLedger.test.ts tests/cursorBridgeQuota.test.ts tests/quotaUiState.test.ts || fail "ledger tests failed"
bun run build >/dev/null || fail "build failed"
git restore --staged dist 2>/dev/null || true

git commit --no-edit -m "Merge upstream main into ledger (resolved by Hermes)" \
  -m "Conflicts: $(echo $conflicts | tr '\n' ' ')" >/dev/null

if [ "$AUTO_MERGE" = "1" ]; then
  git push origin "HEAD:refs/heads/$BRANCH"
  gh issue comment "$issue" --body "Hermes resolved the conflict and pushed to \`$BRANCH\` (AUTO_MERGE=1); verification passed."
  gh workflow run sync-upstream.yml --ref "$BRANCH" || true
  exit 0
fi

git push --quiet origin "HEAD:refs/heads/$fix_branch"
body=$(printf 'Automated merge of upstream main (`%s`) into `%s`, conflicts resolved by Hermes (merge-fixer profile).\n\nVerified independently on openclaw-vm: no conflict markers, valid locale JSON, type-check, Ledger/Cursor tests and build all pass.\n\nCloses #%s once merged.\n\n<details><summary>Hermes summary</summary>\n\n```\n%s\n```\n</details>' \
  "${upstream_sha:0:8}" "$BRANCH" "$issue" "$(tail -c 12000 "$ROOT/hermes-summary.txt")")
pr=$(gh pr create --base "$BRANCH" --head "$fix_branch" --title "Merge upstream ${upstream_sha:0:8} (Hermes-resolved)" --body "$body")
gh issue comment "$issue" --body "Hermes opened $pr with a verified resolution. Merge it to release."
echo "opened $pr"
