# AI gateway (ai.musculoskeletalmso.com)

Shared CLIProxyAPI gateway on openclaw-vm, reached through a Cloudflare Tunnel.

| Piece | Where on openclaw-vm | Listens |
| --- | --- | --- |
| CLIProxyAPI (`install-gateway.sh`) | `/opt/cliproxy`, `cliproxy.service`, user `cliproxy` | 127.0.0.1:8317 |
| Cursor bridge (`cursor-bridge.mjs`) | `/opt/cliproxy/cursor-bridge`, `cursor-bridge.service` | 127.0.0.1:8319 |
| Foundry usage (`foundry-usage.mjs`) | `/opt/cliproxy/foundry-usage`, `foundry-usage.service` | 127.0.0.1:8320 |
| Access gate (`access-gate.mjs`) | `/opt/cliproxy/access-gate`, `access-gate.service` | 127.0.0.1:8316 |
| Tunnel (`cloudflare.mjs create`) | `cloudflared.service`, tunnel `openclaw-ai-gateway` | outbound only |

Routing: the tunnel sends the whole host to access-gate, which verifies the Cloudflare Access JWT (RS256, console app audience, allowed emails) on everything except `/v1/*`, injects the management key for `/v8/management/*` and `/_bridge/foundry/*`, and routes `/_bridge/cursor/*` to 8319, `/_bridge/foundry/*` to 8320, the rest to 8317. The console auto-logs in via `/_bridge/auth/whoami`, so Microsoft sign-in is the only login.

Access (Cloudflare Zero Trust, Entra sign-in): the whole host requires sign-in as
AxelM@musculoskeletalmso.com, mso@musculoskeletalmso.com or yoomd@sdneurosurgery.com,
except `/v1/*`, which is bypassed and protected by per-user gateway API keys.

Secrets live in Key Vault `SDN-SharedVault`: `ai-gateway-management-key`,
`ai-gateway-key-axel`, `ai-gateway-key-yoomd` (also `/root/cliproxy-keys.txt` on the VM).
Accounts (OAuth files) live only in `/opt/cliproxy/auths`. Cursor CLI login is the
`cliproxy` user's (`~/.config/cursor/auth.json`).

Add a user: add a key to `access.api-keys` with `PUT /v0/management/api-keys` (full list; read it first with GET)
and store it as `ai-gateway-key-<name>` in Key Vault. Console access additionally needs
their email in the Access app policy (`cloudflare.mjs`, `ALLOW`).

Member portal: key `ai-gateway-key-member-portal` (label "member-portal (AI usage page)") reads `/v1/_msk/quota` for the SDN AI usage page (2026-10-07).

Quota (`/v1/_msk/quota`): Claude accounts are asked at most every 5 minutes, Codex every minute; a 429 backs that account off for 15 minutes. The last good figures per account are kept in `/opt/cliproxy/access-gate/quota-last.json` (survives restarts) and returned with `stale: true` and `usageAt` while the provider refuses.

## Keyless access for msk (Entra sign-in) and per-person usage

Added 2026-10-02. Configured by the `entra` block in `/opt/cliproxy/access-gate/config.json`.

- **Signing in with a Microsoft token on `/v1`:**
  - API clients may send a Microsoft Entra access token instead of an API key, either as `Authorization: Bearer` or as `x-api-key`. The token is for app "MSK Agent Kit" (`ae407aea-...`), scope `gateway.use`.
  - The gate verifies the signature against the tenant keys, the issuer, the tenant, the audience, the scope and the expiry, then checks `entra.allowedUsers` (a list of UPNs, or `"*"`).
  - It then swaps in that person's own gateway key. The key is created on first use as `sk-msk-u-<name>-...`, added to `access.api-keys` through the management API (`GET`/`PUT /v0/management/api-keys`; the gateway saves its own config and takes the key at once), and recorded in `user-keys.json`. Do not edit the key list in `config.yaml` by hand: the gateway rewrites it as a one-line list, and a file replaced by rename is not hot-reloaded. Add keys with that same management call.
  - Nobody holds a key, and disabling the Entra account ends access.
- **Usage:** every `/v1` request is logged to `/opt/cliproxy/access-gate/usage/YYYY-MM-DD.jsonl`.
  - Each line records the person (Entra users by UPN; key clients by `keyLabels` or a key prefix), the model, the status, and input, cached, cache-write and output tokens, read from the response stream.
  - Each line also records the key used, masked (`sk-msk-u-<name>-…last4` or `<first 8>…last4`). The full key is never logged.
  - `GET /v1/_msk/usage?days=N` returns totals per person (`users`) and per key (`keys`). It is for `entra.admins` only and checks their Microsoft token.
  - `GET /_bridge/usage?days=N` returns the same report to the console (Microsoft sign-in through Cloudflare Access). The console shows it on the **Gateway Usage** page (`#/usage`): totals, one table per person and one per API key.
  - The key table lists every key in `access.api-keys`, including unused ones, and flags keys that have traffic but are no longer configured. Lines logged before keys were recorded are attributed via `keyLabels` and `user-keys.json`.
- **Adding a person:** add their UPN to `entra.allowedUsers` and restart `access-gate`. Their key is created automatically the first time they use msk in clean mode.
- **API keys are unchanged:** existing keys, the bots and Cursor keep working as before.
