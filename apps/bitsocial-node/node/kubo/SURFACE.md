# What pkc-js asks of kubo, and what the facade answers

The calls pkc-js 0.0.132 makes to a kubo node, read from its published `dist/node/` (file and line in that
package), and the kubo-rpc-client it makes them through (7.1.0, pinned by pkc-js's `package.json`). The facade
answers these in kubo's HTTP RPC format under `/api/v0/`, and the gateway under `/ipfs/` and `/ipns/`; any other
command answers `501` with kubo's error body. [`index.js`](index.js) is the way in.

Error bodies are `{"Message","Code","Type":"error"}` with status 500 (kubo's), and the texts pkc-js matches are kept
exactly: `file does not exist`, `is not pinned`, `not pinned or pinned indirectly`, and `no key by the given name was
found`.

## Calls

| Call and options | Where pkc-js makes it | Route | Notes |
|---|---|---|---|
| `block.put(bytes, { format: 'raw', mhtype: 'sha2-256', version: 1, pin: true })` | `util.js:838` | `block/put` | Answers `Key`, `Size`; the node pins in the same call |
| `routing.provide(cid, { recursive: true })` | `util.js:849`, `util.js:882` | `routing/provide` | One query event; a failure is only logged by pkc-js |
| `add(content, { pin: true })` | `util.js:878`, `util.js:918`; options in `local-community.js:308`, `page-generator.js:210`, `page-generator.js:274`, `community-list.js:138` | `add` | The importer `ipfs add` defaults to: CIDv0, dag-pb leaves, 256 KiB chunks; pkc-js addresses what it adds by that CIDv0 |
| `files.write(path, content, { timeout: 60000, create: true, truncate: true, parents: true, flush: true })` | `util.js:950`, called from `comment-updates.js:233` | `files/write` | Multipart body; `timeout` is a number of milliseconds |
| `files.flush(path)` | `comment-updates.js:250`, `comment-updates.js:264` | `files/flush` | Answers `{"Cid"}` |
| `files.stat(path, { hash: true })`, and with no options | `util.js:1041`, called from `cleanup.js:208` and `ipns-publishing.js:27` | `files/stat` | `Blocks` is the link count of a directory; `Hash` is a CIDv1 |
| `files.rm(paths, { recursive: true, force: true })` | `util.js:1002`, called from `cleanup.js:175`, `lifecycle.js:481` | `files/rm` | Empty body on success |
| `files.mv(from, to)` | `editing.js:23` | `files/mv` | |
| `block.rm(cids, options)` | `util.js:977` | `block/rm` | One ndjson line per block. A block that a provide holds is released and removed; one that a pin keeps answers an `Error` line, not a failed call, as kubo does (pkc-js's purge of a comment ends with this call) |
| `pin.ls({ paths: cid })` | `cleanup.js:17` | `pin/ls` | Fails with `path '<cid>' is not pinned` |
| `pin.rm(cid, { recursive: true })` | `cleanup.js:139` | `pin/rm` | Fails with `not pinned or pinned indirectly` |
| `repo.stat({ 'size-only': true })` | `cleanup.js:265` | `repo/stat` | |
| `repo.gc({ quiet: true })` | `cleanup.js:304` | `repo/gc` | One `{Key}` line per block the node dropped; it keeps pinned blocks, provided roots, blocks being read and the DAG a published record names |
| `routing.put('/ipns/<name>', record, { allowOffline: true })` | `anchor-publishing.js:86` | `routing/put` | The signed record goes to the node, which answers once it keeps it and has sent it on its topic; with `allow-offline` (as the call sends it) the put to the DHT runs in the background |
| `name.publish(path, { key, allowOffline: true, resolve: true, ttl: '<n>ms' })` | `ipns-publishing.js:248` | `name/publish` | Go durations are read; the answer's name is base 36 unless `ipns-base` says otherwise; with `allow-offline` the node answers once the record is made, kept and sent on its topic, and the put to the DHT runs in the background |
| `name.resolve(name, { nocache: true, recursive: false, ...loadOpts })` | `base-client-manager.js:554` | `name/resolve` | One hop; with `recursive` the chain to an `/ipfs/` path |
| `key.rm(name)` | `lifecycle.js:475` | `key/rm` | Fails with `no key by the given name was found` |
| `cat(cid, { length, timeout: '<n>ms', signal })` | `base-client-manager.js:698` | `cat` | |
| `id()` | `reprovide-on-address-change.js:27` | `id` | |
| `swarm.addrs()` | `reprovide-on-address-change.js:29` | `swarm/addrs` | |
| `swarm.peers()` | `pkc.js:199` | `swarm/peers` | The peers the node is connected to, each with the address of one connection |
| `pubsub.subscribe(topic, handler, { onError })` | `base-client-manager.js:151` | `pubsub/sub` | A stream of `{from, data, seqno, topicIDs}`, binary fields in multibase |
| `pubsub.unsubscribe(topic, handler)` | `base-client-manager.js:212`, `pkc.js:1187` | `pubsub/sub` (the client leaves) | |
| `pubsub.publish(topic, data)` | `base-client-manager.js:243` | `pubsub/pub` | |
| `pubsub.ls()` | `pkc.js:215`, `pkc.js:1185`, `pubsub.js:17` | `pubsub/ls` | |
| `pubsub.peers(topic)` | `pkc.js:216` | `pubsub/peers` | |
| `config.get('Addresses.Gateway')` | `util.js:1130` | `config` | The facade's own gateway multiaddr (the origin it serves) |
| `config.get('Routing')` | `setup-kubo-http-routers.js:57` | `config` | |

## Raw requests

| Request | Where pkc-js makes it | Answer |
|---|---|---|
| `POST <api>/key/import?arg=<name>&ipns-base=b58mh`, a `FormData` with the key as `file` | `runtime/node/util.js:351` | `{"Name","Id"}`, `Id` the name in base 58; a key that exists answers 500 and pkc-js reads that as "already imported" |
| `POST <api>/config?arg=Routing&arg=<json>&json=true` | `setup-kubo-http-routers.js:69` | Stored; `config.get` answers it |
| `POST <api>/config?arg=Provide.DHT.SweepEnabled&arg=<bool>&json=true` | `setup-kubo-http-routers.js:35` | Stored |
| `POST <api>/shutdown` | `setup-kubo-http-routers.js:94` | Accepted, does nothing; the node is not restarted by a request |
| `GET <gateway>/ipns/<name>?format=ipns-record` | `util.js:1134` | The node's signed record, `application/vnd.ipfs.ipns-record`, passed through |
| the same with `Accept: application/vnd.ipfs.ipns-record`, against any gateway URL | `util.js:1172` | The same |

## Beyond what 0.0.132 calls

Implemented because the mutable file system and the node answer them the same way, and newer pkc-js versions use some of
them: `files/cp` (a CID from `/ipfs/<cid>` or another MFS path), `files/ls`, `files/read`, `files/mkdir`,
`key/gen`, `key/list`, `resolve`, `version`. Not implemented: `dag/*`, `object/*`, `refs`, `dht/*`, `pin/add`
(`block/put` pins in the same call, which is why pkc-js has no `pin.add`), `block/get`.

## Behaviour that follows from the node

- **Pins are roots.** Added content and the MFS root are pinned; the root is pinned again at every flush and the one
  before it unpinned.
- **MFS blocks** are CIDv1, sha2-256, raw leaves, in directories of dag-pb that become HAMT shards once their links
  pass 256 KiB. `files.write` takes `cid-version` and `raw-leaves` for the file it writes.
- **No flush limit.** kubo's `Internal.MFSNoFlushLimit` has no counterpart; nothing in 0.0.132 matches its error.
- **How kubo-rpc-client sends a request.** Every call is `fetch` on the global, looked up when it is made, with a
  `POST`, the options as a query (`arg` repeated for arguments), and a streamed multipart body for `add`,
  `files/write`, `block/put`, `pubsub/pub` and `routing/put`. pkc-js's own raw requests use the same global `fetch`.
  Replacing `globalThis.fetch` ([`fetch-hook.js`](fetch-hook.js)) covers all of it, with no socket.
