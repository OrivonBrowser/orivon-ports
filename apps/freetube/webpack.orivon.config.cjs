// Our build wrapper for upstream FreeTube's Electron-shaped renderer. It
// requires upstream's OWN `_scripts/webpack.web.config.js` from the clone and
// changes only what compiling the Electron renderer, rather than a browser
// tab, needs -- FreeTube's own source and build output stay out of this
// repository (AGPL-3.0-or-later); only this file is ours.
//
// See ../README.md's "Why the Electron renderer, not the web build" for the
// reasoning, and src/build/webpack-kit.cjs for what each call below refuses
// to let happen quietly.
'use strict'

const path = require('node:path')
const { addBrowserFallbacks, cloneRoot, patchPlugins, requireFromClone, retargetOutput } = require('../../src/build/webpack-kit.cjs')

const CLONE = cloneRoot('FREETUBE_CLONE')
const fromClone = requireFromClone(CLONE)

const webpack = fromClone('webpack')
const HtmlWebpackPlugin = fromClone('html-webpack-plugin')
const ProcessLocalesPlugin = require(path.join(CLONE, '_scripts', 'ProcessLocalesPlugin.js'))
const { sigFrameTemplateParameters } = require(path.join(CLONE, '_scripts', 'sigFrameConfig.js'))
const config = require(path.join(CLONE, '_scripts', 'webpack.web.config.js'))

// Never `dist/web`: that directory is `pnpm run pack:web`'s, which another
// run may depend on while this build runs.
const OUTPUT_PATH = path.join(CLONE, 'dist', 'orivon-electron-web')
const OLD_WEB_DIST = path.join(CLONE, 'dist', 'web')

// youtubei.js and googlevideo are stubbed to `{}` upstream, for a browser
// that cannot reach YouTube directly. Bundle them for real.
delete config.externals

// The one DefinePlugin instance carries every process.env.* the renderer
// checks at build time.
//
// src/index.ejs's own `<% if (process.env.IS_ELECTRON) %>` reads THIS SAME
// define -- html-webpack-plugin compiles the ejs template through webpack
// itself, so setting it true here also switches the template to upstream's
// real sigFrame markup (below) instead of the PWA manifest/service-worker
// branch. That is a build-time substitution, unrelated to whether the actual
// Node process running webpack has an IS_ELECTRON env var.
patchPlugins(config, webpack.DefinePlugin, (plugin) => {
  if (plugin.definitions['process.env.SUPPORTS_LOCAL_API'] === undefined) return false
  plugin.definitions['process.env.SUPPORTS_LOCAL_API'] = true
  plugin.definitions['process.env.IS_ELECTRON'] = true
}, { what: 'DefinePlugin carrying SUPPORTS_LOCAL_API' })

// With IS_ELECTRON true the template now takes the branch that renders
// `<iframe id="sigFrame" src="<%= sigFrameSrc %>" ...>` -- upstream's own
// _scripts/webpack.renderer.config.js supplies these two variables the same
// way, from upstream's own sigFrameConfig.js. Without this the build fails at
// HtmlWebpackPlugin time ("sigFrameSrc is not defined"), not silently.
patchPlugins(config, HtmlWebpackPlugin, (plugin) => { plugin.options.templateParameters = sigFrameTemplateParameters })

// src/renderer/i18n/index.js fetches `${locale}.json.br` instead of
// `${locale}.json` once IS_ELECTRON is true (its own comment: "locales are
// only compressed in our production Electron builds") -- that branch is live
// now too, so the name this plugin emits has to match, or every locale fetch
// 404s before the renderer ever mounts.
//
// `compress` picks BOTH the `.br` name and brotli bytes; this port takes the
// name without the bytes, so the emitted `.json.br` is plain JSON that
// `response.json()` parses on any host, with no Content-Encoding to set. See
// ../README.md's "Why the locales are named .br and are not compressed".
// Both are instance fields on an already-constructed plugin, which
// webpack.web.config.js builds at module load and processLocale reads at emit.
patchPlugins(config, ProcessLocalesPlugin, (plugin) => {
  plugin.compress = true
  plugin.compressLocale = async (data) => data
})

// youtubei.js reaches for a few node builtins on its isomorphic paths. An
// empty fallback is the honest setting for a browser bundle, which checks for
// these rather than assuming them.
addBrowserFallbacks(config)

// webpack.web.config.js's SECOND CopyWebpackPlugin (static/, pwabuilder-sw.js,
// shaka-player-locales) writes to HARDCODED `dist/web/...` absolute paths,
// which no change to `output.path` moves. Left alone, this build writes into
// dist/web -- found the hard way, it did once -- and its own tree is missing
// /static/invidious-instances.json, /static/geolocations/*.json and
// /static/external-player-map.json, each one an unawaited Vuex action
// throwing on mount.
retargetOutput(config, { to: OUTPUT_PATH, from: OLD_WEB_DIST })

// The entry stays upstream's single `main.js`. With IS_ELECTRON true,
// local.js's own branch posts to #sigFrame for n/sig deciphering, so
// `orivon-sig-eval.js` (dead code under this define) is never added to it.
module.exports = config
