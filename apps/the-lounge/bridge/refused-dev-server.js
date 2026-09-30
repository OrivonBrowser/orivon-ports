// Stands in for upstream's `server/plugins/dev-server.ts`, which starts a
// Vite server for hot module reloading and is reached only by
// `thelounge start --dev`. The launcher never passes that flag; a person who
// does gets this error instead of a bundle carrying Vite.

import { refusal } from './refusal.js'

export default async function devServer () {
  throw refusal('the development server (--dev)', 'it starts Vite, which is not part of this build; the client is served as upstream built it')
}
