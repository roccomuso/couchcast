import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { silentLogger } from '../logger.js'
import { xml } from './xml.js'

const MAX_TIMEOUT_S = 1800
const NOTIFY_TIMEOUT_MS = 5000

/**
 * @typedef {{
 *   sid: string, service: string, callbacks: URL[], seq: number,
 *   timer: NodeJS.Timeout, timeoutS: number, queue: Promise<void>,
 * }} Subscription
 * @typedef {(service: string) => Record<string, string | number>} StateGetter
 */

/**
 * @param {Record<string, string | number>} vars
 */
export function propertySet (vars) {
  const props = Object.entries(vars).map(([k, v]) => `<e:property><${k}>${xml`${v}`}</${k}></e:property>`)
  return `<?xml version="1.0" encoding="utf-8"?>\n<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">${props.join('')}</e:propertyset>\n`
}

/** @param {string | undefined} header */
export function parseCallbacks (header) {
  /** @type {URL[]} */
  const out = []
  for (const m of (header ?? '').matchAll(/<([^>]+)>/g)) {
    try {
      const u = new URL(m[1])
      if (u.protocol === 'http:') out.push(u)
    } catch {}
  }
  return out
}

/** @param {string | undefined} header */
export function parseTimeout (header) {
  const m = /Second-(\d+)/i.exec(header ?? '')
  const s = m ? Number(m[1]) : MAX_TIMEOUT_S
  return Math.min(Math.max(s, 60), MAX_TIMEOUT_S)
}

/**
 * GENA eventing: SUBSCRIBE / renew / UNSUBSCRIBE and NOTIFY delivery.
 */
export class Gena {
  /** @type {Map<string, Subscription>} */
  #subs = new Map()
  #ac = new AbortController()
  #getState
  #server
  #log

  /**
   * @param {{ getState: StateGetter, server: string, logger?: import('../logger.js').Logger }} opts
   */
  constructor ({ getState, server, logger = silentLogger }) {
    this.#getState = getState
    this.#server = server
    this.#log = logger.child('gena')
  }

  get size () { return this.#subs.size }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} service
   */
  handle (req, res, service) {
    // GENA headers are single-valued; node types custom headers as string | string[].
    const { sid, nt, callback, timeout } = /** @type {Record<string, string | undefined>} */ (req.headers)
    const reply = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers = {}) => {
      res.writeHead(status, { 'Content-Length': '0', Date: new Date().toUTCString(), Server: this.#server, ...headers })
      res.end()
    }

    if (req.method === 'UNSUBSCRIBE') {
      if (callback || nt) return reply(400)
      const sub = typeof sid === 'string' ? this.#subs.get(sid) : undefined
      if (!sub) return reply(412)
      this.#drop(sub)
      return reply(200)
    }

    if (req.method !== 'SUBSCRIBE') return reply(405, { Allow: 'SUBSCRIBE, UNSUBSCRIBE' })

    if (sid) {
      // Renewal: must not carry CALLBACK/NT.
      if (callback || nt) return reply(400)
      const sub = this.#subs.get(String(sid))
      if (!sub || sub.service !== service) return reply(412)
      sub.timeoutS = parseTimeout(timeout)
      this.#arm(sub)
      return reply(200, { SID: sub.sid, TIMEOUT: `Second-${sub.timeoutS}` })
    }

    const callbacks = parseCallbacks(callback)
    if (nt !== 'upnp:event' || callbacks.length === 0) return reply(412)
    /** @type {Subscription} */
    const sub = {
      sid: `uuid:${randomUUID()}`,
      service,
      callbacks,
      seq: 0,
      timeoutS: parseTimeout(timeout),
      timer: /** @type {any} */ (undefined),
      queue: Promise.resolve(),
    }
    this.#subs.set(sub.sid, sub)
    this.#arm(sub)
    this.#log.debug('subscribe %s %s -> %s', service, sub.sid, callbacks[0].href)
    // The initial event (SEQ 0) must follow the SUBSCRIBE response.
    res.once('finish', () => this.#enqueue(sub, this.#getState(service)))
    reply(200, { SID: sub.sid, TIMEOUT: `Second-${sub.timeoutS}` })
  }

  /**
   * Send changed variables to every subscriber of `service`.
   * @param {string} service
   * @param {Record<string, string | number>} vars
   */
  notify (service, vars) {
    for (const sub of this.#subs.values()) {
      if (sub.service === service) this.#enqueue(sub, vars)
    }
  }

  stop () {
    this.#ac.abort()
    for (const sub of this.#subs.values()) clearTimeout(sub.timer)
    this.#subs.clear()
  }

  /** @param {Subscription} sub */
  #arm (sub) {
    clearTimeout(sub.timer)
    sub.timer = setTimeout(() => {
      this.#log.debug('subscription %s expired', sub.sid)
      this.#subs.delete(sub.sid)
    }, sub.timeoutS * 1000)
    sub.timer.unref()
  }

  /** @param {Subscription} sub */
  #drop (sub) {
    clearTimeout(sub.timer)
    this.#subs.delete(sub.sid)
  }

  /**
   * Events for one subscriber are delivered strictly in SEQ order.
   * @param {Subscription} sub
   * @param {Record<string, string | number>} vars
   */
  #enqueue (sub, vars) {
    const seq = sub.seq
    // SEQ wraps to 1, never back to 0 (UDA 1.1 §4.2.1).
    sub.seq = sub.seq >= 0xFFFFFFFF ? 1 : sub.seq + 1
    const body = propertySet(vars)
    sub.queue = sub.queue.then(() => this.#deliver(sub, seq, body))
  }

  /**
   * @param {Subscription} sub
   * @param {number} seq
   * @param {string} body
   */
  async #deliver (sub, seq, body) {
    for (const url of sub.callbacks) {
      if (this.#ac.signal.aborted || !this.#subs.has(sub.sid)) return
      try {
        await sendNotify(url, { sid: sub.sid, seq, body, signal: AbortSignal.any([this.#ac.signal, AbortSignal.timeout(NOTIFY_TIMEOUT_MS)]) })
        return
      } catch (err) {
        this.#log.debug('NOTIFY %s failed: %s', url.href, /** @type {Error} */ (err).message)
      }
    }
  }
}

/**
 * @param {URL} url
 * @param {{ sid: string, seq: number, body: string, signal: AbortSignal }} opts
 */
function sendNotify (url, { sid, seq, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'NOTIFY',
      signal,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        NT: 'upnp:event',
        NTS: 'upnp:propchange',
        SID: sid,
        SEQ: String(seq),
        Connection: 'close',
      },
    }, (res) => {
      res.resume()
      res.on('end', () => res.statusCode === 200 ? resolve(undefined) : reject(new Error(`HTTP ${res.statusCode}`)))
    })
    req.on('error', reject)
    req.end(body)
  })
}
