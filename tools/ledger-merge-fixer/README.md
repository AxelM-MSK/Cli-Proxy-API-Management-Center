# ledger-merge-fixer

Runs on openclaw-vm. Hourly (`ledger-merge-fixer.timer`, :50) it looks for an open
"Upstream merge conflict" issue, which `sync-upstream.yml` opens when upstream
main does not merge cleanly into `ledger`. When it finds one it:

1. clones the fork, merges upstream main into `ledger`;
2. runs Hermes (`hermes -p merge-fixer`, Foundry `gpt-5-6-hermes`, terminal + file
   toolsets, its own profile with no helpdesk memory) to resolve the conflicts;
3. verifies independently: no unmerged paths or markers, valid locale JSON,
   type-check, Ledger/Cursor tests, build;
4. pushes `auto/merge-upstream-<sha>` and opens a PR into `ledger` (or comments
   on the issue with Hermes's summary if anything fails).

Merging the PR triggers the release workflow. `AUTO_MERGE=1` in
`~/.config/ledger-merge-fixer.env` pushes straight to `ledger` instead.

Install: `install.sh` as root, with `FIXER_B64` / `SOUL_B64` set to the base64 of
`ledger-merge-fixer.sh` / `SOUL.md`. Logs: `~/ledger-merge-fixer/logs/`.
Test against throwaway branches with `UPSTREAM`, `UPSTREAM_REF`, `BRANCH`,
`ISSUE_TITLE` overrides.
