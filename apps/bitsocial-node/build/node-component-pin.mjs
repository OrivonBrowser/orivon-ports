// Written by node-component.mjs from a build of the node component: the CID of the folder it is published under, its flags, its features, each file's size and sha256, and the size and sha256 of the packed form of the files that have one.
export default {
  "cid": "bafybeife66rdie2cphpxps6eas4mg57qydhc64gi3frptgkxdkscfawtby",
  "features": [
    "add",
    "pin",
    "car",
    "provide",
    "ipns",
    "sealed-keys",
    "punch",
    "serve",
    "listen",
    "pubsub",
    "ipns-import",
    "routing-put",
    "ipns-pubsub",
    "relay",
    "bandwidth"
  ],
  "flags": [
    "--publish",
    "--key-secret",
    "--max-ipns-keys",
    "--http-router",
    "--punch-port",
    "--relay"
  ],
  "files": [
    {
      "name": "ipfs-node.js",
      "bytes": 1029188,
      "sha256": "0e48e86a1716884a1667b71e51f8ba0b5ed818f4281dce5edd543f4470f172a1",
      "under": "bin/ipfs-node.p2"
    },
    {
      "name": "ipfs-node.core.wasm",
      "bytes": 20097456,
      "sha256": "94dfed25c55bb8dc5dce5081360d70e86f35f4eea254a053aee733494ac8f529",
      "under": "bin/ipfs-node.p2"
    },
    {
      "name": "ipfs-node.core2.wasm",
      "bytes": 4045,
      "sha256": "2e45f4f3a2928147d4ea2dbb5afa5a6026482289e306392ef2800722c74bcca8",
      "under": "bin/ipfs-node.p2"
    },
    {
      "name": "ipfs-node.core3.wasm",
      "bytes": 1731,
      "sha256": "c39914f56dea422520474032edb3e7143cffc08e50c68e235daa31b666d1c9a0",
      "under": "bin/ipfs-node.p2"
    },
    {
      "name": "ipfs-node.core4.wasm",
      "bytes": 697,
      "sha256": "e4f5dcbc92d32580d19dba858350be65fd44279ebe1ac9493f984823f0ef52cc",
      "under": "bin/ipfs-node.p2"
    },
    {
      "name": "LICENSE-MIT",
      "bytes": 1082,
      "sha256": "4d43d56a52c3d8589952406bc48733ec49b36e2b53c31f506d36502d9ca8bc57",
      "under": "bin"
    },
    {
      "name": "LICENSE-APACHE",
      "bytes": 9010,
      "sha256": "fc42cd60b58eaad23773716b9889fd66f5386ebe5717e90772cd04a51dfb08ce",
      "under": "bin"
    }
  ],
  "packed": [
    {
      "name": "ipfs-node.js",
      "replaces": "ipfs-node.js",
      "bytes": 1029550,
      "sha256": "4fdb0a6e7cff8ca2e291c4dcfa04c3fd818f72db5a17fa3720c1cbb29f4d53c1",
      "under": "bin/ipfs-node.p2"
    },
    {
      "name": "ipfs-node.core.wasm.deflate",
      "replaces": "ipfs-node.core.wasm",
      "bytes": 6260967,
      "sha256": "e6e74b90839562068871b527584ecf84cabfc728f6a10211d9a1b6aedad80e88",
      "under": "bin/ipfs-node.p2"
    }
  ]
}
