#!/bin/sh
# Installs the Share relay from this checkout on its host. Run it with sudo, from a checkout of main.
# The host needs node (22.18 or later) and npm. The firewall, if there is one, must let 4003/tcp in.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
install -d /opt/share-relay
install -m 0644 "$here"/*.mjs "$here"/package.json "$here"/package-lock.json /opt/share-relay/
(cd /opt/share-relay && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
install -m 0644 "$here"/share-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable share-relay.service
systemctl restart share-relay.service
systemctl --no-pager --lines=5 status share-relay.service
