// The page the "node" link opens: the node app's dashboard module (node-dashboard.js, loaded before this) draws the node into the
// frame the build wrote, `term` is 5chan's word for what a node hosts, `features` names the sections 5chan offers in it, and `addressSetting` says where 5chan's own settings
// change a board's address. node-start.js (loaded before this) has started the node or found it running.

(function () {
  const root = document.getElementById('node-dashboard')
  const dashboard = globalThis.BitsocialNodeDashboard
  if (dashboard === undefined) root.textContent = 'The node dashboard did not load.'
  else dashboard.mountNodeDashboard({ root, node: window.orivonBitsocialNode, app: { name: '5chan', term: 'board', features: ['board-manager', 'listing', 'name', 'challenges', 'seeding', 'reach'], addressSetting: '5chan\'s Board Settings (the "address" line)' } })
})()
