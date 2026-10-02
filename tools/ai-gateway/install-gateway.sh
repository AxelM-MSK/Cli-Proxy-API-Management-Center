#!/bin/bash
# Step 1: CLIProxyAPI on openclaw-vm as a dedicated service user, loopback only.
set -euo pipefail
VER=8.0.11
BASE=/opt/cliproxy
id cliproxy >/dev/null 2>&1 || useradd --system --home-dir $BASE --create-home --shell /usr/sbin/nologin cliproxy
install -d -o cliproxy -g cliproxy -m 750 $BASE $BASE/bin $BASE/auths $BASE/logs
cd /tmp
curl -fsSLO "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$VER/CLIProxyAPI_${VER}_linux_amd64.tar.gz"
curl -fsSLO "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$VER/checksums.txt"
grep " CLIProxyAPI_${VER}_linux_amd64.tar.gz\$" checksums.txt | sha256sum -c -
rm -rf /tmp/cpa-x && mkdir /tmp/cpa-x && tar -xzf "CLIProxyAPI_${VER}_linux_amd64.tar.gz" -C /tmp/cpa-x
install -o root -g root -m 755 /tmp/cpa-x/cli-proxy-api $BASE/bin/cli-proxy-api
[ -f $BASE/config.example.yaml ] || install -o cliproxy -g cliproxy -m 640 /tmp/cpa-x/config.example.yaml $BASE/config.example.yaml

gen() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ ! -f $BASE/config.yaml ]; then
  MGMT=$(gen); K_AXEL="sk-axel-$(gen)"; K_YOO="sk-yoo-$(gen)"
  umask 077
  cat > $BASE/config.yaml <<YAML
config-version: 8
server:
  host: "127.0.0.1"
  port: 8317
management:
  allow-remote: false
  secret-key: "$MGMT"
  disable-control-panel: false
  panel-github-repository: "https://github.com/AxelM-MSK/Cli-Proxy-API-Management-Center"
access:
  api-keys:
    - "$K_AXEL"
    - "$K_YOO"
routing:
  strategy: "round-robin"
  session-affinity: true
  session-affinity-ttl: "2h"
  session-affinity-subagents: true
  retry:
    request-retry: 3
oauth:
  auth-dir: "$BASE/auths"
observability:
  logs:
    logging-to-file: true
YAML
  # Who holds which key, for revocation; readable by root only.
  printf 'management=%s\naxel=%s\nyoo=%s\n' "$MGMT" "$K_AXEL" "$K_YOO" > /root/cliproxy-keys.txt
  chmod 600 /root/cliproxy-keys.txt
  chown cliproxy:cliproxy $BASE/config.yaml; chmod 600 $BASE/config.yaml
fi

cat > /etc/systemd/system/cliproxy.service <<'UNIT'
[Unit]
Description=CLIProxyAPI shared gateway (ai.musculoskeletalmso.com)
After=network-online.target
Wants=network-online.target

[Service]
User=cliproxy
Group=cliproxy
WorkingDirectory=/opt/cliproxy
ExecStart=/opt/cliproxy/bin/cli-proxy-api -config /opt/cliproxy/config.yaml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cliproxy.service
sleep 4
systemctl is-active cliproxy.service
ss -ltnp | grep ':8317 ' || true
K=$(sed -n 's/^axel=//p' /root/cliproxy-keys.txt)
curl -s -o /dev/null -w 'models with key: %{http_code}\n' -H "Authorization: Bearer $K" http://127.0.0.1:8317/v1/models
curl -s -o /dev/null -w 'models without key: %{http_code}\n' http://127.0.0.1:8317/v1/models
