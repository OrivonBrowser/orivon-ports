# Orivon Share copy service

An optional copy of a share on Orivon's server. A person who ticks "Keep a copy on Orivon's server for 30
days" when sharing gets a share whose raw IPFS address and gateway link open from anywhere, also with the
sender's computer off. The Share page sends the share's CAR here after it has made the share, and accepts the
copy only when this service answers with the address the page computed itself.

| | |
|---|---|
| Runs | `share-copy.service` on Orivon's server, as a dynamic user; `share-copy-expire.timer` runs the daily expiry |
| Listens | `127.0.0.1:8093`, behind Caddy at `https://telemetry.orivonstack.com/share/*` |
| Keeps | Each copy for 30 days, on Orivon's own Kubo node and on Orivon's Filebase account, both pinned from one CAR import |
| Takes | A CAR of 200 MiB or less that holds one share and nothing else; protected shares arrive as the locked file |
| Built on | Node 22.18 or later, no dependencies; the CAR reader and the address code of [`page/src/ipfs/`](../page/src/ipfs/) |

## What it keeps, and for whom

- **A share without a password is public on Orivon's server.** Anyone who has its address can read the copy
  from the node, from Filebase and from the gateways that find them. The page says so beside the box.
- **A protected share stays locked.** The page sends the CAR of what it keeps: `share.age` and
  `HOW-TO-OPEN.txt`, whose bytes are the age file. The service never receives the files, the password or a key.
- **Nothing says who sent it.** The record holds an address, a time, a size and where it is pinned. Requests
  are counted per client in memory only (an IPv6 address by its /64) and the counts are gone at midnight UTC or
  at a restart. Caddy keeps no access log.
- **Nothing outlives 30 days** unless the node or the account held the same address before the service saw it,
  in which case that pin is not the service's to end.

## What it accepts

`POST /api/v0/keep?arg=<address>` takes the CAR as its body (`application/vnd.ipld.car`, with a length).

1. The CAR is read block by block: each block is hashed and compared with its address, only files and folders
   (dag-pb and raw) are taken, and the CAR must hold the share the address names exactly, every block
   reachable from it and none missing. A block sent twice is kept once.
2. The checked blocks are written to disk as a CAR of the service's own. That file, never the bytes it was
   sent, is what is imported ([`rules.mjs`](rules.mjs)).
3. The address is asked of the node and of Filebase (`pin/ls`). One that already pins it is left alone and
   never unpinned; any unclear answer refuses the copy. The pin line is written before the import, so a crash
   leaves a pin the expiry job ends.
4. The CAR is imported (`dag/import?pin-roots=true`) on the node, then on Filebase. If either fails, whatever
   the service pinned is unpinned, the line is dropped, and the page is told to try later. A CAR import is
   not read by Filebase's content filter, which refuses some files an `add` would carry.
5. The answer is `{"Name":"share","Hash":"<address>","Size":"<bytes>","KeptUntil":"<time>"}`; a refusal is
   Kubo's error shape, `{"Message":"...","Code":0,"Type":"error"}`, in words the page shows.

`POST /api/v0/status?arg=<address>&size=<bytes>` answers whether the address is kept (`KeptUntil` set), and
otherwise whether a copy of that size would be taken, with the same refusals, so the page sends nothing for a
share that is kept or would be refused. `POST /api/v0/version` and `GET /health` say that it runs.

A share kept once is answered as kept, with the same day, and not imported again. When its month is over a new
copy starts a new month.

## Its limits

| What | Limit |
|---|---|
| One copy | A CAR of 200 MiB (`CAR_BYTES`), at most 40000 blocks; the page checks it before it sends a byte |
| Kept at once, all shares | 1 GiB (`LIVE_BYTES`) |
| From one address in a day | 512 MiB (`DAY_BYTES`), 10 copies and 60 requests |
| At once | 2 copies, one per address; a sender that stalls 30 s, or averages under 20 KiB/s after a minute, is stopped |
| Time | 30 days from the copy, then unpinned from the node and the account |
| Memory, CPU | 300 MB (`MemoryMax`), low priority; a CAR is streamed to disk and on to the node and the account, never held (a 190 MiB copy used about 55 MB of memory) |

The limits are *provisional*. The Filebase account is shared with Orivon's own pins and with DecentraWiki's
free pinning, and its plan size is not known to this repository. What settles them: the plan size
from Filebase, and a month of `pins.jsonl` (bytes kept per day) on the server. Share's limits are its own, so
Share can never use DecentraWiki's room: this service counts its own copies, and the DecentraWiki relay counts
its own.

## Design notes

**A service of its own, not DecentraWiki's relay run twice.** The two share a shape: a Kubo-compatible
service in front of Filebase, an append-only record, a daily expiry and a takedown. They do not share the
work. DecentraWiki's relay is made of the rules about one kind of wiki, rebuilds a 12 MiB upload from files it
recognises, and holds it in memory; Share's takes any share up to 200 MiB as a CAR and streams it to disk, so
a second instance would carry rules it must switch off, and the two would share a state directory, a port
and a release. One service with per-app configuration would tie the two apps' releases together, and a bug in
one would stop the other. An app does not import another app's files (`CLAUDE.md` Rule 7), so Share's copy
writes the pieces it needs again here: the record ([`store.mjs`](store.mjs)), the calls to a Kubo-compatible
API ([`backend.mjs`](backend.mjs)), the client counting and the expiry. The record's lines have the shape of
DecentraWiki's, so the Filebase mirror job reads both the same way.

**The CAR, not the files.** The page already makes the CAR (the "Download as a CAR file" button), the
address is the root of it, and a CAR import reproduces the page's blocks exactly. Rebuilding the share from
files would depend on the service chunking as the page does.

**Both places or neither.** The node is Orivon's own, and Filebase is what stays up when the node does not. A
copy that only one of them took would be reported as kept and open only sometimes.

## The record, and takedown

`/var/lib/share-copy/pins.jsonl` is only ever appended to: one line per copy (address, time, bytes, whether
the service pinned it on the node and on the account), a line to end one, a line to forget one that failed or
that a new copy replaces. Each line starts on a line of its own, so a line cut short by a crash costs only
itself. `blocked.jsonl` lists taken-down addresses.

```
sudo systemctl start share-copy-expire                # end the copies whose month is over (the timer does it daily)
sudo systemd-run --pty -p DynamicUser=yes -p StateDirectory=share-copy \
  -p EnvironmentFile=/etc/share-copy/secrets.env -p Environment=STATE_DIR=/var/lib/share-copy \
  /usr/local/bin/node /opt/share-copy/copy/expire.mjs <address>...    # take a share down now
```

`expire.mjs <address>` unpins the copy from the node and the account whatever its age, and blocks the
address, so it is refused from then on. Copies of it that other nodes hold are not the service's to end.

## The Filebase mirror job

Orivon's server runs a job (`orivon-filebase-sync`, from orivon-mvp) that keeps the Filebase account to what
the node serves now, and unpins the rest after a grace period. It spares the pins named in the record it is
given. [`install.sh`](install.sh) adds a drop-in that gives it DecentraWiki's record and this service's
together, so that a copy is not unpinned from Filebase before its month is over.

## Files

| File | What it is |
|---|---|
| [`copy.mjs`](copy.mjs) | The service: the three calls, the budgets, the order of a copy |
| [`rules.mjs`](rules.mjs) | What a share is: the check of a CAR, and its limits |
| [`store.mjs`](store.mjs) | The record of copies and of takedowns |
| [`backend.mjs`](backend.mjs) | The pin check, CAR import and unpin of a Kubo-compatible API: the node and Filebase |
| [`expire.mjs`](expire.mjs) | The daily expiry, and the takedown |
| [`share-copy.service`](share-copy.service), [`share-copy-expire.service`](share-copy-expire.service), [`share-copy-expire.timer`](share-copy-expire.timer) | The systemd units and their hardening |
| [`install.sh`](install.sh) | Installs the service from a checkout |
| [`test/`](test/) | The check of a CAR, the record, and the service started as systemd starts it, with a fake node and a fake account |

Settings, all optional but the key: `FILEBASE_KEY` (required, in `/etc/share-copy/secrets.env`, mode 600),
`PORT`, `STATE_DIR`, `FILEBASE_RPC`, `KUBO_RPC`, `CAR_BYTES`, `LIVE_BYTES`, `DAY_BYTES`.

## Deploying it

On the server, with `/etc/share-copy/secrets.env` written, from a checkout of `main`:

```
sudo sh apps/share/copy/install.sh
```

It copies the service and the address code it uses to `/opt/share-copy`, installs the units, and starts the
service and the timer. Caddy sends `/share/*` to port 8093, with a request body limit of 201 MiB on that path.
The page reads the service's address from [`orivon-copy.js`](../page/src/publish/orivon-copy.js).

```
journalctl -u share-copy -n 20      # one [share-copy] line per copy, with no address of anyone
```
