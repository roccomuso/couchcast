export const SSDP_ADDRESS = '239.255.255.250'
export const SSDP_PORT = 1900

/**
 * @typedef {{ nt: string, usn: string }} Target
 * @typedef {{
 *   location: string, server: string, maxAge: number,
 *   bootId: number, configId: number,
 * }} AdvertiseInfo
 * @typedef {{
 *   kind: 'request', method: string, headers: Record<string, string>
 * } | {
 *   kind: 'response', status: number, headers: Record<string, string>
 * }} SsdpMessage
 */

/**
 * The full set of NT/USN pairs a root device must advertise (UDA 1.1 §1.1.2):
 * rootdevice, the device UDN, the device type, and each service type.
 * @param {{ udn: string, deviceType: string, serviceTypes: string[] }} desc
 * @returns {Target[]}
 */
export function targets ({ udn, deviceType, serviceTypes }) {
  return [
    { nt: 'upnp:rootdevice', usn: `${udn}::upnp:rootdevice` },
    { nt: udn, usn: udn },
    { nt: deviceType, usn: `${udn}::${deviceType}` },
    ...serviceTypes.map((st) => ({ nt: st, usn: `${udn}::${st}` })),
  ]
}

const versioned = /^(urn:[^:]+:(?:device|service):[^:]+):(\d+)$/

/**
 * Which targets answer a given ST. Per UDA, a search for an older version of a
 * type we implement must be answered, echoing the requested ST.
 * @param {string} st
 * @param {Target[]} all
 * @returns {Array<{ st: string, usn: string }>}
 */
export function matchSearch (st, all) {
  if (st === 'ssdp:all') return all.map((t) => ({ st: t.nt, usn: t.usn }))
  const exact = all.find((t) => t.nt === st)
  if (exact) return [{ st, usn: exact.usn }]
  const want = versioned.exec(st)
  if (!want) return []
  for (const t of all) {
    const have = versioned.exec(t.nt)
    if (have && have[1] === want[1] && Number(have[2]) >= Number(want[2])) {
      return [{ st, usn: t.usn.replace(t.nt, st) }]
    }
  }
  return []
}

/** @param {Record<string, string | number>} headers */
const lines = (headers) =>
  Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')

/**
 * @param {Target} target
 * @param {AdvertiseInfo} info
 */
export function notifyAlive ({ nt, usn }, { location, server, maxAge, bootId, configId }) {
  return Buffer.from(`NOTIFY * HTTP/1.1\r\n${lines({
    HOST: `${SSDP_ADDRESS}:${SSDP_PORT}`,
    'CACHE-CONTROL': `max-age=${maxAge}`,
    LOCATION: location,
    NT: nt,
    NTS: 'ssdp:alive',
    SERVER: server,
    USN: usn,
    'BOOTID.UPNP.ORG': bootId,
    'CONFIGID.UPNP.ORG': configId,
  })}\r\n\r\n`)
}

/**
 * @param {Target} target
 * @param {Pick<AdvertiseInfo, 'bootId' | 'configId'>} info
 */
export function notifyByebye ({ nt, usn }, { bootId, configId }) {
  return Buffer.from(`NOTIFY * HTTP/1.1\r\n${lines({
    HOST: `${SSDP_ADDRESS}:${SSDP_PORT}`,
    NT: nt,
    NTS: 'ssdp:byebye',
    USN: usn,
    'BOOTID.UPNP.ORG': bootId,
    'CONFIGID.UPNP.ORG': configId,
  })}\r\n\r\n`)
}

/**
 * @param {{ st: string, usn: string }} match
 * @param {AdvertiseInfo & { date?: Date }} info
 */
export function searchResponse ({ st, usn }, { location, server, maxAge, bootId, configId, date = new Date() }) {
  return Buffer.from(`HTTP/1.1 200 OK\r\n${lines({
    'CACHE-CONTROL': `max-age=${maxAge}`,
    DATE: date.toUTCString(),
    EXT: '',
    LOCATION: location,
    SERVER: server,
    ST: st,
    USN: usn,
    'BOOTID.UPNP.ORG': bootId,
    'CONFIGID.UPNP.ORG': configId,
  })}\r\n\r\n`)
}

/**
 * @param {string} st
 * @param {{ mx?: number, host?: string }} [opts]
 */
export function mSearch (st, { mx = 2, host = `${SSDP_ADDRESS}:${SSDP_PORT}` } = {}) {
  return Buffer.from(`M-SEARCH * HTTP/1.1\r\n${lines({
    HOST: host,
    MAN: '"ssdp:discover"',
    MX: mx,
    ST: st,
  })}\r\n\r\n`)
}

/**
 * Parse an SSDP datagram. Header names are lower-cased. Returns null for junk.
 * @param {Buffer | string} buf
 * @returns {SsdpMessage | null}
 */
export function parseMessage (buf) {
  const text = buf.toString('utf8')
  const [start, ...rest] = text.split(/\r?\n/)
  /** @type {Record<string, string>} */
  const headers = {}
  for (const line of rest) {
    if (!line) break
    const i = line.indexOf(':')
    if (i <= 0) continue
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  const res = /^HTTP\/1\.[01] (\d{3})/.exec(start)
  if (res) return { kind: 'response', status: Number(res[1]), headers }
  const req = /^([A-Z-]+) \* HTTP\/1\.[01]$/.exec(start.trim())
  if (req) return { kind: 'request', method: req[1], headers }
  return null
}
