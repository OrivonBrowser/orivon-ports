# Orivon Share relay

A libp2p circuit relay (v2) that Orivon runs for Orivon Share. Behind a home router nobody can dial
the IPFS node that serves a share, so the share's address does not load in other IPFS apps or on
gateways. A node that keeps a reservation on this relay announces an address that goes through it
(`/ip4/152.228.138.30/tcp/4003/p2p/<relay peer ID>/p2p-circuit/p2p/<node peer ID>`), and any IPFS node
or gateway reaches it through the relay for as long as the node stays connected.

| | |
|---|---|
| Runs | `share-relay.service` on Orivon's server, as a dynamic user |
| Listens | `0.0.0.0:4003/tcp` |
| Announces | `/ip4/152.228.138.30/tcp/4003` |
| Built on | js-libp2p: TCP, Noise, Yamux, identify, ping, circuit relay v2 server (versions in [`package.json`](package.json), pinned by [`package-lock.json`](package-lock.json)) |
| Peer ID | Kept in the service's state directory, so it survives restarts and upgrades |

## What it never does

- **It stores nothing.** No file, no block, no list of who connected: the one thing it keeps on disk is
  its own private key (`/var/lib/share-relay/peer-key.pb`, mode 0600).
- **It cannot read what it relays.** The two ends of a relayed connection run Noise between them, so
  the relay passes bytes it cannot decrypt, and it never asks for a key.
- **It dials no one.** A connection gater refuses every outgoing dial, so it cannot be used to reach an
  address a client names. It relays only between a connection that asked for a peer and a peer that holds
  a reservation on it.
- **It never logs or keeps an IP address.** The journal gets a start line (the relay's own addresses) and
  one counter line an hour; an error is logged by its name alone, because libp2p's messages can carry a
  peer's address. libp2p keeps a connection's address in memory for as long as the connection is open,
  as any server does, and nothing writes it anywhere.

## What it sends: no limit

A reservation answer and a connect answer carry **no limit**: no byte cap and no time cap. A go-libp2p
client marks a relayed connection as limited when the relay sends any limit, and Kubo and gateways then
refuse to fetch blocks over a limited connection, so a relay that sends the usual 128 KiB and two
minutes would carry nothing a share is made of. js-libp2p sends none when the server is started with
`reservations: { applyDefaultLimit: false }`, which [`node.mjs`](node.mjs) sets.
[`test/relay.test.ts`](test/relay.test.ts) reads the answers as bytes and fails when either holds a limit,
and sends 3 MiB each way over one relayed stream.

## Its limits

An open relay with no byte cap is a way for anyone to spend this server's bandwidth, so it is bounded
by count and by the host instead:

| What | Limit |
|---|---|
| Reservations held at once | 512; the 513th is refused until one expires |
| A reservation | One hour; a client that stays connected renews it |
| Reservations from one address (an IPv6 /64) | 16, so one host cannot take the table; the 17th is refused |
| Connections | 768 in all; past that libp2p closes the ones it values least |
| Connections still being set up | 32 |
| New connections from one address | 10 a second |
| Circuits asked over one connection at once | 32 |
| Circuits opened to one reserved peer at once | 64 |
| Memory, CPU | 300 MB, one core (`MemoryMax`, `CPUQuota`), at low priority (`Nice=5`) |

A relayed connection can only be made to a peer that holds a reservation on this relay, so the relay
reaches nobody who did not ask to be reached.

Not limited, and open: how many bytes one circuit may move, and who may reserve. Anyone with a libp2p
client can hold a reservation, and two such clients can send each other as much as the server's network
allows. A cap that is not sent to clients cannot be built from js-libp2p's options (the limit it
enforces is the limit it sends); a rate limit or an allowlist of peers would be written here, once abuse
shows.

## What it logs

At the start, one line with the relay's addresses and peer ID. Then every hour:

```
share-relay stats: reservations=12 connections=31 circuits_since_last=40 bytes_since_last=1048576 circuits_total=912 bytes_total=88000000
```

`reservations` and `connections` are the ones open now; the circuits and bytes are totals the process
counted. libp2p exposes no counter for either, so [`node.mjs`](node.mjs) wraps the server's connect
handler and counts one circuit when the destination answers and each byte once, where it is read from
either end. A test fails when an update of the library changes what that relies on.

```
journalctl -u share-relay -n 20
```

## Files

| File | What it is |
|---|---|
| [`relay.mjs`](relay.mjs) | The service: reads its settings from the environment, starts the node, logs the counters, stops on SIGTERM |
| [`node.mjs`](node.mjs) | The libp2p node, the limits above, and the counters |
| [`key.mjs`](key.mjs) | Reads the Ed25519 key from the state directory, or makes it on the first start |
| [`probe.mjs`](probe.mjs) | `node probe.mjs <relay multiaddr>` dials the relay, prints its peer ID and protocols, and exits 1 unless it serves relay v2 hops |
| [`share-relay.service`](share-relay.service) | The systemd unit and its hardening |
| [`install.sh`](install.sh) | Installs the service from a checkout |
| [`test/relay.test.ts`](test/relay.test.ts) | Starts the node and the service, and checks the limits, the circuits and the key |

Settings, all optional: `STATE_DIR` (where the key lives), `LISTEN` and `ANNOUNCE` (comma-separated
multiaddrs; an empty `ANNOUNCE` announces the listen address), `LOG_EVERY_MS`.

## Running the tests

```
npm run relay:install       # once, from the repository root
npm test
```

The tests start the relay on a loopback port with a key in a scratch directory and connect real
libp2p nodes to it; they need no network.

## Deploying it

On the server, from a checkout of `main`:

```
sudo sh apps/share/relay/install.sh
```

It copies the service to `/opt/share-relay`, installs the locked dependencies there with
`npm ci --omit=dev --ignore-scripts`, installs the unit, enables it at boot and restarts it. The
firewall must let `4003/tcp` in. To roll back, check out the earlier commit and run it again; the key
and with it the peer ID stay in `/var/lib/share-relay`.

```
sudo systemctl restart share-relay     # restart
sudo systemctl status share-relay      # state
sudo systemctl stop share-relay        # stop; reservations are dropped and clients make new ones
```

## Design notes

**Why `applyDefaultLimit: false` and not a large limit.** Any limit makes a go-libp2p client call the
connection limited, whatever its size. Only an absent limit makes it an ordinary connection.

**Why reservations last an hour.** A node that stays open renews its reservation before it ends; a node
that is closed or crashed stops holding one within the hour, so the table of 512 does not fill with
nodes that left.
