import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { silentLogger } from '../logger.js'
import {
  SSDP_ADDRESS, SSDP_PORT, matchSearch, notifyAlive, notifyByebye,
  parseMessage, searchResponse, targets,
} from './messages.js'

export * from './messages.js'

/**
 * @typedef {{
 *   address: string,
 *   location: string,
 *   udn: string,
 *   deviceType: string,
 *   serviceTypes: string[],
 *   server: string,
 *   bootId: number,
 *   configId: number,
 *   maxAge?: number,
 *   port?: number,
 *   ttl?: number,
 *   logger?: import('../logger.js').Logger,
 * }} SsdpOptions
 */

/**
 * SSDP advertiser + M-SEARCH responder for a single root device on a single
 * interface. Emits 'search' ({ address, st, userAgent }) for every M-SEARCH we answer.
 */
export class SsdpServer extends EventEmitter {
  /** @type {dgram.Socket | null} */
  #socket = null
  /** @type {Set<NodeJS.Timeout>} */
  #timers = new Set()
  #opts
  #targets
  #log

  /** @param {SsdpOptions} opts */
  constructor (opts) {
    super()
    // `??` rather than spread defaults: callers may pass explicit undefined.
    this.#opts = { ...opts, maxAge: opts.maxAge ?? 1800, port: opts.port ?? SSDP_PORT, ttl: opts.ttl ?? 2 }
    this.#targets = targets(opts)
    this.#log = (opts.logger ?? silentLogger).child('ssdp')
  }

  /** Port actually bound (useful when constructed with port 0). */
  get port () {
    return this.#socket?.address().port ?? 0
  }

  async start () {
    const { address, port, ttl } = this.#opts
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.#socket = socket
    socket.on('message', (msg, rinfo) => this.#onMessage(msg, rinfo))
    socket.on('error', (err) => this.#log.warn('socket error: %s', err.message))
    // Bind the wildcard address: Linux only delivers multicast to sockets bound to it.
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(port, () => { socket.off('error', reject); resolve(undefined) })
    })
    try {
      socket.addMembership(SSDP_ADDRESS, address)
      socket.setMulticastInterface(address)
      socket.setMulticastTTL(ttl)
      socket.setMulticastLoopback(true)
    } catch (err) {
      // Unicast M-SEARCH still works; discovery by multicast won't.
      this.#log.warn('multicast setup failed on %s: %s', address, /** @type {Error} */ (err).message)
    }
    this.#log.debug('listening on udp/%d, advertising %s', this.port, this.#opts.location)
    // UDP is lossy: announce twice, shortly apart, then keep re-announcing.
    await this.#announce()
    this.#later(() => this.#announce(), 1000 + Math.random() * 1000)
    this.#scheduleReannounce()
  }

  async stop () {
    const socket = this.#socket
    if (!socket) return
    for (const t of this.#timers) clearTimeout(t)
    this.#timers.clear()
    await this.#multicast((t) => notifyByebye(t, this.#opts))
    this.#log.debug('sent ssdp:byebye')
    try { socket.dropMembership(SSDP_ADDRESS, this.#opts.address) } catch {}
    await new Promise((resolve) => socket.close(() => resolve(undefined)))
    this.#socket = null
  }

  #announce () {
    this.#log.debug('sending ssdp:alive (%d targets)', this.#targets.length)
    return this.#multicast((t) => notifyAlive(t, this.#opts))
  }

  #scheduleReannounce () {
    // Re-announce at ~1/3 of max-age (with jitter), well before clients expire us.
    const base = (this.#opts.maxAge * 1000) / 3
    this.#later(async () => {
      await this.#announce()
      this.#scheduleReannounce()
    }, base * (0.9 + Math.random() * 0.2))
  }

  /**
   * @param {() => void} fn
   * @param {number} ms
   */
  #later (fn, ms) {
    const t = setTimeout(() => { this.#timers.delete(t); fn() }, ms)
    this.#timers.add(t)
  }

  /** @param {(t: import('./messages.js').Target) => Buffer} build */
  async #multicast (build) {
    await Promise.all(this.#targets.map((t) => this.#send(build(t), SSDP_PORT, SSDP_ADDRESS)))
  }

  /**
   * Never rejects: a dropped datagram is not worth crashing over.
   * @param {Buffer} buf @param {number} port @param {string} host
   */
  #send (buf, port, host) {
    return new Promise((resolve) => {
      if (!this.#socket) return resolve(undefined)
      this.#socket.send(buf, port, host, (err) => {
        if (err) this.#log.debug('send to %s:%d failed: %s', host, port, err.message)
        resolve(undefined)
      })
    })
  }

  /**
   * @param {Buffer} buf
   * @param {dgram.RemoteInfo} rinfo
   */
  #onMessage (buf, rinfo) {
    const msg = parseMessage(buf)
    if (!msg || msg.kind !== 'request' || msg.method !== 'M-SEARCH') return
    const { man, st, mx, host = '' } = msg.headers
    if (man?.replace(/"/g, '') !== 'ssdp:discover' || !st) return
    const matches = matchSearch(st, this.#targets)
    if (matches.length === 0) return
    this.emit('search', { address: rinfo.address, st, userAgent: msg.headers['user-agent'] ?? '' })
    this.#log.debug('M-SEARCH %s from %s:%d', st, rinfo.address, rinfo.port)
    // #send never rejects, so the promise can be dropped safely.
    const respond = () => {
      for (const m of matches) this.#send(searchResponse(m, this.#opts), rinfo.port, rinfo.address)
    }
    // Multicast searches get a random delay within MX (we cap at 1s: a lone
    // server can't cause a response storm, and VLC's UI benefits from speed).
    // Unicast searches must be answered immediately.
    const multicast = host.startsWith(SSDP_ADDRESS)
    const mxSec = Math.max(0, Math.min(Number(mx) || 0, 1))
    if (!multicast || mxSec === 0) respond()
    else this.#later(respond, Math.random() * mxSec * 1000)
  }
}
