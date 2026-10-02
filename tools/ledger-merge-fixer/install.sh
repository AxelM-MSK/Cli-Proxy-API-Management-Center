#!/bin/bash
# Installs the ledger merge-fixer on openclaw-vm (run as root via run-command).
# Payload files arrive base64-encoded in the variables below.
set -euo pipefail
U=azureuser
H=/home/$U
ROOT=$H/ledger-merge-fixer
PROFILE=$H/.hermes/profiles/merge-fixer

install -d -o $U -g $U -m 750 "$ROOT" "$ROOT/logs"
echo "$FIXER_B64" | base64 -d > "$ROOT/ledger-merge-fixer.sh"
chown $U:$U "$ROOT/ledger-merge-fixer.sh"; chmod 750 "$ROOT/ledger-merge-fixer.sh"

# Dedicated Hermes profile: same Foundry deployment as the helpdesk, but its
# own (empty) memory and no helpdesk skills, so code work never mixes with
# ticket history.
if [ ! -d "$PROFILE" ]; then
  runuser -u $U -- $H/.local/bin/hermes profile create merge-fixer >/dev/null 2>&1 || install -d -o $U -g $U -m 700 "$PROFILE"
fi
cat > "$PROFILE/config.yaml" <<'YAML'
model:
  provider: azure-foundry
  base_url: https://mskmso-foundry.openai.azure.com/openai/v1
  api_mode: chat_completions
  auth_mode: entra_id
  default: gpt-5-6-hermes
plugins:
  enabled: []
agent: {}
YAML
echo "$SOUL_B64" | base64 -d > "$PROFILE/SOUL.md"
chown -R $U:$U "$PROFILE"; chmod 600 "$PROFILE/config.yaml"

cat > /etc/systemd/system/ledger-merge-fixer.service <<UNIT
[Unit]
Description=Hermes resolves upstream merge conflicts for the Ledger console fork
After=network-online.target

[Service]
Type=oneshot
User=$U
WorkingDirectory=$ROOT
Environment=HOME=$H
Environment=PATH=$H/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$ROOT/ledger-merge-fixer.sh
TimeoutStartSec=1h
Nice=10
UNIT

cat > /etc/systemd/system/ledger-merge-fixer.timer <<'UNIT'
[Unit]
Description=Check hourly for a Ledger fork merge conflict

[Timer]
OnCalendar=*-*-* *:50:00
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now ledger-merge-fixer.timer
echo "installed:"; ls -la "$ROOT" "$PROFILE" | head -20
systemctl list-timers ledger-merge-fixer.timer --no-pager | head -3
