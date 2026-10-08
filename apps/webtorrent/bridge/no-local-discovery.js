// Stands in for bittorrent-lsd, BitTorrent's local service discovery, which
// finds peers on the same network over multicast UDP on port 6771. Orivon's
// dgram offers no multicast, so the module is not a constructor here, and
// torrent-discovery leaves local discovery off when it is not one, as
// webtorrent's own browser build does. Peers still come from trackers, the
// DHT and peer exchange.

export default null
