// The page the "node" link opens: the node app's dashboard module (node-dashboard.js, loaded before this) draws the node into the
// frame the build wrote, `term` is seedit's word for what a node hosts, `features` names the sections seedit offers in it, and `addressSetting` says where seedit's own settings
// change a community's address. node-start.js (loaded before this) has started the node or found it running.

(function () {
  const root = document.getElementById('node-dashboard')
  const dashboard = globalThis.BitsocialNodeDashboard
  if (dashboard === undefined) root.textContent = 'The node dashboard did not load.'
  else dashboard.mountNodeDashboard({ root, node: window.orivonBitsocialNode, app: { name: 'seedit', term: 'community', features: ['listing-signature', 'name', 'challenges', 'seeding', 'reach'], addressSetting: 'seedit\'s Community Settings (the Address box)' } })
})()
