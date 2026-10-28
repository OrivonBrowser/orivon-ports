#!/bin/sh
# Installs Orivon Share's copy service from this checkout on Orivon's server. Run it with sudo.
# /etc/share-copy/secrets.env must hold FILEBASE_KEY=<the account's IPFS RPC key>, mode 600. The service reaches
# the Kubo node beside it at KUBO_RPC, 127.0.0.1:5001 by default.
# Where the Filebase mirror job (orivon-filebase-sync) runs, it is told to spare this service's live pins as
# it spares DecentraWiki's: it otherwise unpins from the account what no IPNS key or keep list names.
set -eu
app=$(cd "$(dirname "$0")/.." && pwd)
test -f /etc/share-copy/secrets.env || { echo "write /etc/share-copy/secrets.env (FILEBASE_KEY=..., mode 600) first" >&2; exit 1; }
install -d /opt/share-copy/copy /opt/share-copy/page/src/ipfs
install -m 0644 "$app"/copy/*.mjs /opt/share-copy/copy/
install -m 0644 "$app"/page/src/ipfs/*.js /opt/share-copy/page/src/ipfs/
printf '{ "type": "module" }\n' > /opt/share-copy/package.json
install -m 0644 "$app"/copy/share-copy.service "$app"/copy/share-copy-expire.service "$app"/copy/share-copy-expire.timer /etc/systemd/system/
if [ -f /etc/systemd/system/orivon-filebase-sync.service ]; then
  install -d /etc/systemd/system/orivon-filebase-sync.service.d
  cat > /etc/systemd/system/orivon-filebase-sync.service.d/share-copy.conf <<'DROPIN'
[Service]
RuntimeDirectory=orivon-filebase-sync
ExecStartPre=/bin/sh -c 'cat /var/lib/decentrawiki-relay/pins.jsonl /var/lib/share-copy/pins.jsonl > /run/orivon-filebase-sync/protect.jsonl || true'
Environment=PROTECT_FILE=/run/orivon-filebase-sync/protect.jsonl
DROPIN
fi
systemctl daemon-reload
systemctl enable share-copy.service share-copy-expire.timer
systemctl restart share-copy.service
systemctl start share-copy-expire.timer
systemctl --no-pager --lines=3 status share-copy.service
