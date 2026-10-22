// Runs before the TiddlyWiki core in the editing frame: the core must not boot
// until the editor page has handed over the wiki's tiddlers (frame-boot.js).
window.$tw = window.$tw || Object.create(null)
window.$tw.boot = window.$tw.boot || Object.create(null)
window.$tw.boot.suppressBoot = true
