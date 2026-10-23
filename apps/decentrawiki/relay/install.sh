#!/bin/sh
# Installs DecentraWiki's free pinning relay from this checkout on the pinning host. Run it with sudo.
# /etc/decentrawiki-relay/secrets.env must hold FILEBASE_KEY=<the account's IPFS RPC key>, mode 600.
set -eu
app=$(cd "$(dirname "$0")/.." && pwd)
test -f /etc/decentrawiki-relay/secrets.env || { echo "write /etc/decentrawiki-relay/secrets.env (FILEBASE_KEY=..., mode 600) first" >&2; exit 1; }
install -d /opt/decentrawiki-relay/relay /opt/decentrawiki-relay/page/src/ipfs
install -m 0644 "$app"/relay/*.mjs /opt/decentrawiki-relay/relay/
install -m 0644 "$app"/page/src/ipfs/*.js /opt/decentrawiki-relay/page/src/ipfs/
printf '{ "type": "module" }\n' > /opt/decentrawiki-relay/package.json
install -m 0644 "$app"/relay/decentrawiki-relay.service "$app"/relay/decentrawiki-relay-expire.service "$app"/relay/decentrawiki-relay-expire.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable decentrawiki-relay.service decentrawiki-relay-expire.timer
systemctl restart decentrawiki-relay.service
systemctl start decentrawiki-relay-expire.timer
systemctl --no-pager --lines=3 status decentrawiki-relay.service
