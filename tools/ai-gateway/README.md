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

Add a user: append a key to `access.api-keys` in `/opt/cliproxy/config.yaml` (hot-reloaded)
and store it as `ai-gateway-key-<name>` in Key Vault. Console access additionally needs
their email in the Access app policy (`cloudflare.mjs`, `ALLOW`).
