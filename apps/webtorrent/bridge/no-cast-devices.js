// Stands in for chromecasts, dlnacasts and airplayer. Each finds devices on
// the local network with multicast UDP (mDNS or SSDP), which Orivon's
// dgram does not offer, so each answers as it would on a network with no
// devices: an empty player list that never grows. Upstream's cast menu then
// lists nothing, as it does at home with no Chromecast.

import { EventEmitter } from 'node:events'

let told = false

export default function noCastDevices () {
  if (!told) {
    told = true
    console.info('WebTorrent in Orivon: casting finds no Chromecast, AirPlay or DLNA device, because device discovery needs multicast UDP, which Orivon does not provide')
  }
  const finder = new EventEmitter()
  finder.players = []
  finder.update = () => {}
  finder.destroy = () => {}
  return finder
}
