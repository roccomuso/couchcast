import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RangeNotSatisfiableError } from '../errors.js'
import { silentLogger } from '../logger.js'
import { parseRange } from './range.js'

export { parseRange } from './range.js'

/**
 * @typedef {{
 *   id: number, itemId: string, title: string,
 *   client: { address: string, label: string },
 *   start: number, end: number, size: number, bytesSent: number,
 *   startedAt: number, bytesPerSec: number,
 * }} StreamSnapshot
 * @typedef {StreamSnapshot & { res: import('node:http').ServerResponse, lastBytes: number }} Session
 * @typedef {{
 *   path: string, size: number, mtimeMs: number, mime: string,
 *   itemId: string, title: string,
 *   client: { address: string, label: string },
 *   contentFeatures?: string,
 *   headers?: Record<string, string>,
 *   track?: boolean,
 * }} ServeOptions
 */

const TRANSFER_MODES = new Set(['Streaming', 'Interactive', 'Background'])
const HIGH_WATER_MARK = 256 * 1024

/**
 * HTTP file streaming with Range support and DLNA headers.
 * Events: 'start' (snapshot), 'end' (snapshot, reason), 'progress' (snapshots[]).
 * reason ∈ 'complete' | 'aborted' | 'error'.
 */
export class StreamManager extends EventEmitter {
  /** @type {Map<number, Session>} */
  #sessions = new Map()
  #nextId = 1
  /** @type {NodeJS.Timeout | undefined} */
  #ticker
  #intervalMs
  #log

  /** @param {{ progressIntervalMs?: number, logger?: import('../logger.js').Logger }} [opts] */
  constructor ({ progressIntervalMs = 1000, logger = silentLogger } = {}) {
    super()
    this.#intervalMs = progressIntervalMs
    this.#log = logger.child('stream')
  }

  /** @returns {StreamSnapshot[]} */
  get active () {
    return [...this.#sessions.values()].map(snapshot)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {ServeOptions} opts
   */
  async serve (req, res, opts) {
    const { path, size, mtimeMs, mime } = opts
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    // We advertise DLNA.ORG_OP=01 (byte seek only); time-based seek is a client bug.
    if (req.headers['timeseekrange.dlna.org']) {
      res.writeHead(406).end()
      return
    }

    let range
    try {
      range = parseRange(req.headers.range, size)
    } catch (err) {
      if (!(err instanceof RangeNotSatisfiableError)) throw err
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }).end()
      return
    }

    const requestedMode = String(req.headers['transfermode.dlna.org'] ?? '')
    /** @type {Record<string, string | number>} */
    const headers = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(mtimeMs).toUTCString(),
      'transferMode.dlna.org': TRANSFER_MODES.has(requestedMode) ? requestedMode : 'Streaming',
      ...opts.headers,
    }
    if (opts.contentFeatures && req.headers['getcontentfeatures.dlna.org'] === '1') {
      headers['contentFeatures.dlna.org'] = opts.contentFeatures
    }
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    const length = size === 0 ? 0 : end - start + 1
    headers['Content-Length'] = length
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    res.writeHead(range ? 206 : 200, headers)

    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }

    /** @type {Session | null} */
    const session = opts.track === false
      ? null
      : this.#open({ ...opts, start, end, res })
    const file = createReadStream(path, { start, end, highWaterMark: HIGH_WATER_MARK })
    const meter = new Transform({
      highWaterMark: HIGH_WATER_MARK,
      transform (chunk, _enc, cb) {
        if (session) session.bytesSent += chunk.length
        cb(null, chunk)
      },
    })

    /** @type {'complete' | 'aborted' | 'error'} */
    let reason = 'complete'
    try {
      // pipeline() propagates backpressure from the socket down to the file
      // read, and destroys the file stream if the client goes away.
      await pipeline(file, meter, res)
    } catch (err) {
      const e = /** @type {NodeJS.ErrnoException} */ (err)
      if (e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'ECONNRESET' || e.code === 'EPIPE' || res.destroyed) {
        reason = 'aborted'
      } else {
        reason = 'error'
        this.#log.warn('streaming %s failed: %s', path, e.message)
        res.destroy()
      }
    } finally {
      if (session) this.#close(session, reason)
    }
  }

  /** Abort every in-flight stream (used on shutdown). */
  stop () {
    for (const s of this.#sessions.values()) s.res.destroy()
    clearInterval(this.#ticker)
    this.#ticker = undefined
  }

  /**
   * @param {ServeOptions & { start: number, end: number, res: import('node:http').ServerResponse }} o
   * @returns {Session}
   */
  #open (o) {
    /** @type {Session} */
    const s = {
      id: this.#nextId++,
      itemId: o.itemId,
      title: o.title,
      client: o.client,
      start: o.start,
      end: o.end,
      size: o.size,
      bytesSent: 0,
      startedAt: Date.now(),
      bytesPerSec: 0,
      lastBytes: 0,
      res: o.res,
    }
    this.#sessions.set(s.id, s)
    if (!this.#ticker) {
      this.#ticker = setInterval(() => this.#tick(), this.#intervalMs)
      this.#ticker.unref()
    }
    this.#log.debug('#%d %s %s bytes=%d-%d/%d', s.id, s.client.address, s.title, s.start, s.end, s.size)
    this.emit('start', snapshot(s))
    return s
  }

  /**
   * @param {Session} s
   * @param {'complete' | 'aborted' | 'error'} reason
   */
  #close (s, reason) {
    this.#sessions.delete(s.id)
    if (this.#sessions.size === 0) {
      clearInterval(this.#ticker)
      this.#ticker = undefined
    }
    this.#log.debug('#%d %s after %d bytes', s.id, reason, s.bytesSent)
    this.emit('end', snapshot(s), reason)
  }

  #tick () {
    const dt = this.#intervalMs / 1000
    for (const s of this.#sessions.values()) {
      const rate = (s.bytesSent - s.lastBytes) / dt
      s.lastBytes = s.bytesSent
      // EWMA keeps the UI number from jumping around with TCP bursts.
      s.bytesPerSec = s.bytesPerSec === 0 ? rate : s.bytesPerSec * 0.7 + rate * 0.3
    }
    this.emit('progress', this.active)
  }
}

/** @param {Session} s @returns {StreamSnapshot} */
function snapshot (s) {
  const { res: _res, lastBytes: _lb, ...rest } = s
  return { ...rest, client: { ...s.client } }
}
