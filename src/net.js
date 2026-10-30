import { networkInterfaces } from 'node:os'
import { CouchcastError, ErrorCode } from './errors.js'

/**
 * @typedef {{ name: string, address: string, netmask: string, mac: string }} NetInterface
 */

// VPNs, tunnels, VMs, containers, Apple's AWDL/LLW, loopback.
const SKIP = /^(lo|utun|ipsec|tun|tap|wg|ppp|gif|stf|anpi|ap\d|awdl|llw|bridge|docker|br-|veth|virbr|vboxnet|vmnet|zt|tailscale)/i
// Typical physical LAN NICs, in preference order.
const PREFER = [/^en\d/, /^eth\d/, /^wl/, /^enp/, /^eno/]

/**
 * List IPv4 interfaces suitable for DLNA, best first.
 * @param {ReturnType<typeof networkInterfaces>} [ifaces]
 * @returns {NetInterface[]}
 */
export function candidateInterfaces (ifaces = networkInterfaces()) {
  /** @type {NetInterface[]} */
  const out = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (SKIP.test(name)) continue
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('169.254.')) continue // link-local
      out.push({ name, address: a.address, netmask: a.netmask, mac: a.mac })
    }
  }
  const rank = (/** @type {string} */ n) => {
    const i = PREFER.findIndex((re) => re.test(n))
    return i === -1 ? PREFER.length : i
  }
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'en', { numeric: true }))
}

/**
 * Pick the interface to serve on. `wanted` may be an interface name (en0)
 * or an IPv4 address; explicit choices bypass the skip list (so lo0 works).
 * @param {string} [wanted]
 * @param {ReturnType<typeof networkInterfaces>} [ifaces]
 * @returns {NetInterface}
 */
export function pickInterface (wanted, ifaces = networkInterfaces()) {
  if (wanted) {
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs ?? []) {
        if (a.family !== 'IPv4') continue
        if (name === wanted || a.address === wanted) {
          return { name, address: a.address, netmask: a.netmask, mac: a.mac }
        }
      }
    }
    throw new CouchcastError(ErrorCode.NO_INTERFACE, `No IPv4 interface matches "${wanted}"`)
  }
  const [best] = candidateInterfaces(ifaces)
  if (!best) {
    throw new CouchcastError(ErrorCode.NO_INTERFACE, 'No LAN interface found. Are you connected to a network? Use --interface to pick one.')
  }
  return best
}
