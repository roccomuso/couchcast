import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import { resolve } from 'node:path'
import { loadState, configDir } from './config.js'
import { CouchcastError, ErrorCode, UpnpError, UpnpErrorCode } from './errors.js'
import { ID_PATTERN, Library } from './library/index.js'
import { silentLogger } from './logger.js'
import { pickInterface } from './net.js'
import { Prober, SUBTITLE_MIME, dlnaFeatures } from './probe/index.js'
import { clientLabel, resolveQuirks } from './quirks.js'
import { SsdpServer } from './ssdp/index.js'
import { StreamManager } from './stream/index.js'
import { connectionManagerState, createConnectionManager } from './upnp/connection-manager.js'
import { createContentDirectory } from './upnp/content-directory.js'
import { DESCRIPTION_PATH, DEVICE_TYPE, SERVICES, configIdFor, deviceDescription } from './upnp/device.js'
import { mimeFor, subtitleUrl } from './upnp/didl.js'
import { Gena } from './upnp/gena.js'
import { CONNECTION_MANAGER, CONTENT_DIRECTORY, scpd } from './upnp/scpd.js'
import { parseSoapRequest, soapFault, soapResponse } from './upnp/soap.js'
import { VERSION } from './version.js'

export { VERSION }

export const DEFAULT_PORT = 8200
const MAX_SOAP_BODY = 64 * 1024
const SOAP_BODY_TIMEOUT_MS = 10_000
const CLIENT_TTL_MS = 10 * 60_000
const XML_TYPE = 'text/xml; charset="utf-8"'

/**
 * @typedef {{
 *   dir?: string,
 *   name?: string,
 *   port?: number,
 *   interface?: string,
 *   ffprobe?: boolean,
 *   watch?: boolean,
 *   ssdpPort?: number,
 *   configDir?: string,
 *   logger?: import('./logger.js').Logger,
 * }} ServerOptions
 * @typedef {{ address: string, userAgent: string, label: string, firstSeen: number, lastSeen: number, requests: number }} ClientInfo
 * @typedef {{
 *   name: string, udn: string, url: string, descriptionUrl: string,
 *   interface: string, address: string, port: number, dir: string,
 *   videoCount: number, systemUpdateId: number, ffprobe: boolean,
 *   subscriptions: number,
 *   clients: ClientInfo[], streams: import('./stream/index.js').StreamSnapshot[],
 * }} ServerState
 */

export const SERVER_HEADER = `${os.type()}/${os.release()} UPnP/1.0 DLNADOC/1.50 couchcast/${VERSION}`

/**
 * The DLNA MediaServer. Emits:
 * - 'update'        something in snapshot() changed (UI should re-render)
 * - 'stream:start'  (StreamSnapshot)
 * - 'stream:end'    (StreamSnapshot, reason)
 * - 'play'          ({ client, title }) a client started a new title
 */
export class CouchcastServer extends EventEmitter {
  /** @type {Map<string, ClientInfo>} */
  #clients = new Map()
  /** @type {Map<string, number>} `${address}\0${itemId}` → last start, to log "playing" once */
  #recentPlays = new Map()
  /** @type {http.Server | null} */
  #http = null
  /** @type {SsdpServer | null} */
  #ssdp = null
  /** @type {Gena | null} */
  #gena = null
  /** @type {Library | null} */
  #library = null
  /** @type {NodeJS.Timeout | undefined} */
  #sweeper
  #streams
  #updateId = Math.floor(Date.now() / 1000) >>> 0
  #descriptionXml = ''
  #baseUrl = ''
  #udn = ''
  #iface = { name: '', address: '' }
  #ffprobe = false
  #started = false
  #opts
  #log
  /** @type {Record<string, { type: string, scpd: string, actions: Record<string, import('./upnp/content-directory.js').ActionHandler> }>} */
  #services = {}

  /** @param {ServerOptions} [opts] */
  constructor (opts = {}) {
    super()
    this.#opts = {
      ...opts,
      dir: resolve(opts.dir ?? process.cwd()),
      name: opts.name || `couchcast on ${os.hostname().replace(/\.local$/, '')}`,
    }
    this.#log = (opts.logger ?? silentLogger).child('server')
    this.#streams = new StreamManager({ logger: opts.logger })
    this.#streams.on('start', (s) => {
      this.#notePlay(s)
      this.emit('stream:start', s)
      this.emit('update')
    })
    this.#streams.on('end', (s, reason) => {
      this.emit('stream:end', s, reason)
      this.emit('update')
    })
    this.#streams.on('progress', () => this.emit('update'))
  }

  get library () { return this.#library }
  get baseUrl () { return this.#baseUrl }

  async start () {
    if (this.#started) throw new CouchcastError(ErrorCode.INVALID_ARG, 'Server already started')
    this.#started = true
    const { dir, name, logger } = this.#opts
    const st = await stat(dir).catch(() => null)
    if (!st?.isDirectory()) throw new CouchcastError(ErrorCode.NOT_A_DIRECTORY, `Not a directory: ${dir}`)

    const persisted = await loadState({ dir: this.#opts.configDir ?? configDir() })
    this.#udn = `uuid:${persisted.uuid}`
    this.#iface = pickInterface(this.#opts.interface)

    const prober = await Prober.create({ enabled: this.#opts.ffprobe !== false, logger })
    this.#ffprobe = prober.ffprobe
    this.#library = new Library({ root: dir, title: name, prober, logger })
    await this.#library.scan()
    this.#log.info('indexed %d videos in %s', this.#library.videoCount, dir)

    this.#services = {
      cds: {
        type: SERVICES.cds.type,
        scpd: scpd(CONTENT_DIRECTORY),
        actions: createContentDirectory({ library: this.#library, getUpdateId: () => this.#updateId }),
      },
      cms: {
        type: SERVICES.cms.type,
        scpd: scpd(CONNECTION_MANAGER),
        actions: createConnectionManager(),
      },
    }
    this.#descriptionXml = deviceDescription({ udn: this.#udn, friendlyName: name, version: VERSION })
    this.#gena = new Gena({
      server: SERVER_HEADER,
      logger,
      getState: (svc) => svc === 'cds' ? { SystemUpdateID: this.#updateId } : connectionManagerState(),
    })

    await this.#listen()

    this.#ssdp = new SsdpServer({
      address: this.#iface.address,
      location: `${this.#baseUrl}${DESCRIPTION_PATH}`,
      udn: this.#udn,
      deviceType: DEVICE_TYPE,
      serviceTypes: Object.values(SERVICES).map((s) => s.type),
      server: SERVER_HEADER,
      bootId: Math.floor(Date.now() / 1000),
      configId: configIdFor(VERSION),
      port: this.#opts.ssdpPort,
      logger,
    })
    this.#ssdp.on('search', ({ address, st: target, userAgent }) =>
      this.#log.debug('discovered by %s (%s) for %s', address, userAgent || 'no UA', target))
    await this.#ssdp.start()

    this.#library.on('change', () => this.#bumpUpdateId('library changed'))
    this.#library.on('probed', () => this.#bumpUpdateId('metadata updated'))
    if (this.#opts.watch !== false) this.#library.watch()

    this.#sweeper = setInterval(() => this.#sweepClients(), 60_000)
    this.#sweeper.unref()
    this.#log.info('"%s" ready at %s on %s', name, this.#baseUrl, this.#iface.name)
    this.emit('update')
  }

  /** Port the SSDP socket is bound to (tests use an ephemeral one). */
  get ssdpPort () { return this.#ssdp?.port ?? 0 }

  async rescan () {
    if (!this.#library) return false
    this.#log.info('rescanning %s', this.#opts.dir)
    const changed = await this.#library.scan()
    if (!changed) this.#log.info('no changes (%d videos)', this.#library.videoCount)
    return changed
  }

  async stop () {
    if (!this.#started) return
    this.#started = false
    clearInterval(this.#sweeper)
    this.#library?.stop()
    // byebye first, while the network is surely still up.
    await this.#ssdp?.stop().catch((err) => this.#log.warn('ssdp stop: %s', err.message))
    this.#gena?.stop()
    this.#streams.stop()
    const server = this.#http
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined))
        server.closeAllConnections()
      })
    }
    this.#http = null
    this.#log.debug('stopped')
  }

  /** @returns {ServerState} */
  snapshot () {
    const cutoff = Date.now() - CLIENT_TTL_MS
    return {
      name: /** @type {string} */ (this.#opts.name),
      udn: this.#udn,
      url: this.#baseUrl,
      descriptionUrl: `${this.#baseUrl}${DESCRIPTION_PATH}`,
      interface: this.#iface.name,
      address: this.#iface.address,
      port: Number(new URL(this.#baseUrl || 'http://x:0').port),
      dir: /** @type {string} */ (this.#opts.dir),
      videoCount: this.#library?.videoCount ?? 0,
      systemUpdateId: this.#updateId,
      ffprobe: this.#ffprobe,
      subscriptions: this.#gena?.size ?? 0,
      clients: [...this.#clients.values()].filter((c) => c.lastSeen >= cutoff).sort((a, b) => b.lastSeen - a.lastSeen),
      streams: this.#streams.active,
    }
  }

  async #listen () {
    const server = http.createServer((req, res) => {
      this.#route(req, res).catch((err) => {
        this.#log.error('%s %s: %s', req.method, req.url, err.stack ?? err.message)
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0' }).end()
        else res.destroy()
      })
    })
    // Long-lived streams: no response timeout. Header timeout stays as a slowloris guard.
    server.requestTimeout = 0
    server.keepAliveTimeout = 15_000
    server.on('clientError', (_err, socket) => socket.destroy())
    this.#http = server

    const { address } = this.#iface
    const explicit = this.#opts.port
    const tryListen = (/** @type {number} */ port) => new Promise((resolve, reject) => {
      const onError = (/** @type {NodeJS.ErrnoException} */ err) => reject(err)
      server.once('error', onError)
      server.listen(port, address, () => { server.off('error', onError); resolve(undefined) })
    })
    try {
      await tryListen(explicit ?? DEFAULT_PORT)
    } catch (err) {
      const e = /** @type {NodeJS.ErrnoException} */ (err)
      if (e.code !== 'EADDRINUSE') throw e
      if (explicit !== undefined) {
        throw new CouchcastError(ErrorCode.PORT_IN_USE, `Port ${explicit} is already in use on ${address}`, { cause: e })
      }
      this.#log.debug('port %d busy, using an ephemeral port', DEFAULT_PORT)
      await tryListen(0)
    }
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port
    this.#baseUrl = `http://${address}:${port}`
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async #route (req, res) {
    res.setHeader('Server', SERVER_HEADER)
    this.#touchClient(req)
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    this.#log.debug('%s %s from %s', req.method, path, req.socket.remoteAddress)

    if (path === DESCRIPTION_PATH || path === '/') {
      return this.#sendXml(req, res, this.#descriptionXml)
    }
    let m = /^\/upnp\/(cds|cms)\/(scpd\.xml|control|event)$/.exec(path)
    if (m) {
      const [, key, what] = m
      if (what === 'scpd.xml') return this.#sendXml(req, res, this.#services[key].scpd)
      if (what === 'event') return this.#gena?.handle(req, res, key)
      return this.#control(req, res, key)
    }
    m = /^\/media\/([\w-]+)(?:\.\w+)?$/.exec(path)
    if (m && ID_PATTERN.test(m[1])) return this.#media(req, res, m[1])
    m = /^\/subs\/([\w-]+)\.srt$/.exec(path)
    if (m && ID_PATTERN.test(m[1])) return this.#subtitle(req, res, m[1])

    res.writeHead(404, { 'Content-Length': '0' }).end()
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} body
   */
  #sendXml (req, res, body) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    res.writeHead(200, { 'Content-Type': XML_TYPE, 'Content-Length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} key service key
   */
  async #control (req, res, key) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const service = this.#services[key]
    const send = (/** @type {number} */ status, /** @type {string} */ body) => {
      res.writeHead(status, { 'Content-Type': XML_TYPE, 'Content-Length': Buffer.byteLength(body), EXT: '' })
      res.end(body)
    }
    let body
    try {
      body = await readBody(req, MAX_SOAP_BODY, AbortSignal.timeout(SOAP_BODY_TIMEOUT_MS))
    } catch {
      res.writeHead(400, { Connection: 'close' }).end()
      return
    }
    try {
      const call = parseSoapRequest(body, /** @type {string | undefined} */ (req.headers.soapaction))
      const handler = Object.hasOwn(service.actions, call.action) ? service.actions[call.action] : undefined
      if (!handler) throw new UpnpError(UpnpErrorCode.INVALID_ACTION, 'Invalid Action')
      const ctx = { quirks: resolveQuirks(req.headers), baseUrl: this.#baseUrl }
      this.#log.debug('%s.%s %j', key, call.action, call.args)
      send(200, soapResponse(service.type, call.action, handler(call.args, ctx)))
    } catch (err) {
      if (err instanceof UpnpError) {
        this.#log.debug('%s fault %d: %s', key, err.upnpCode, err.description)
        return send(500, soapFault(err.upnpCode, err.description))
      }
      if (err instanceof CouchcastError && err.code === ErrorCode.SOAP_PARSE) {
        this.#log.debug('bad SOAP from %s: %s', req.socket.remoteAddress, err.message)
        return send(500, soapFault(UpnpErrorCode.INVALID_ACTION, 'Invalid Action'))
      }
      throw err
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} id
   */
  async #media (req, res, id) {
    const item = this.#library?.get(id)
    if (!item || item.kind !== 'item') {
      res.writeHead(404, { 'Content-Length': '0' }).end()
      return
    }
    const quirks = resolveQuirks(req.headers)
    const media = /** @type {Library} */ (this.#library).media(item)
    /** @type {Record<string, string>} */
    const headers = {}
    // Samsung asks for the subtitle URL via a request header instead of DIDL.
    if (item.subtitle && req.headers['getcaptioninfo.sec'] === '1') {
      headers['CaptionInfo.sec'] = subtitleUrl(item, this.#baseUrl)
    }
    await this.#streams.serve(req, res, {
      path: item.path,
      size: item.size,
      mtimeMs: item.mtimeMs,
      mime: mimeFor(media, quirks),
      contentFeatures: dlnaFeatures(),
      itemId: item.id,
      title: item.title,
      client: { address: clientAddress(req), label: clientLabel(req.headers) },
      headers,
    })
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} id
   */
  async #subtitle (req, res, id) {
    const item = this.#library?.get(id)
    if (!item || item.kind !== 'item' || !item.subtitle) {
      res.writeHead(404, { 'Content-Length': '0' }).end()
      return
    }
    const quirks = resolveQuirks(req.headers)
    await this.#streams.serve(req, res, {
      path: item.subtitle.path,
      size: item.subtitle.size,
      mtimeMs: item.subtitle.mtimeMs,
      mime: quirks.subtitleMime ?? SUBTITLE_MIME,
      contentFeatures: 'DLNA.ORG_OP=01;DLNA.ORG_CI=0',
      itemId: item.id,
      title: `${item.title}.srt`,
      client: { address: clientAddress(req), label: clientLabel(req.headers) },
      // Subtitle fetches must not count as streams (keep-awake, UI).
      track: false,
    })
  }

  /** @param {string} reason */
  #bumpUpdateId (reason) {
    this.#updateId = ((this.#updateId + 1) >>> 0) || 1
    this.#log.info('%s: %d videos (SystemUpdateID %d)', reason, this.#library?.videoCount ?? 0, this.#updateId)
    this.#gena?.notify('cds', { SystemUpdateID: this.#updateId })
    this.emit('update')
  }

  /** @param {http.IncomingMessage} req */
  #touchClient (req) {
    const address = clientAddress(req)
    const ua = String(req.headers['user-agent'] ?? '')
    const now = Date.now()
    const known = this.#clients.get(address)
    if (known) {
      known.lastSeen = now
      known.requests++
      // Clients use several stacks (e.g. VLC for SOAP, AVFoundation for media):
      // keep the most recognizable name.
      const label = clientLabel(req.headers)
      if (resolveQuirks(req.headers).label || !known.label) {
        known.label = label
        known.userAgent = ua
      }
      return
    }
    const info = { address, userAgent: ua, label: clientLabel(req.headers), firstSeen: now, lastSeen: now, requests: 1 }
    this.#clients.set(address, info)
    this.#log.info('new client %s (%s)', address, info.label)
    this.emit('update')
  }

  /** @param {import('./stream/index.js').StreamSnapshot} s */
  #notePlay (s) {
    const key = `${s.client.address}\0${s.itemId}`
    const last = this.#recentPlays.get(key) ?? 0
    const now = Date.now()
    this.#recentPlays.set(key, now)
    if (now - last > 60_000) {
      this.#log.info('▶ %s playing "%s"', s.client.label, s.title)
      this.emit('play', { client: s.client, title: s.title })
    }
  }

  #sweepClients () {
    const cutoff = Date.now() - CLIENT_TTL_MS
    for (const [k, c] of this.#clients) if (c.lastSeen < cutoff) this.#clients.delete(k)
    for (const [k, t] of this.#recentPlays) if (t < cutoff) this.#recentPlays.delete(k)
  }
}

/** @param {http.IncomingMessage} req */
function clientAddress (req) {
  return (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')
}

/**
 * Buffer a small request body with a size cap and a deadline.
 * @param {http.IncomingMessage} req
 * @param {number} limit
 * @param {AbortSignal} signal
 */
async function readBody (req, limit, signal) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  const onAbort = () => req.destroy(new Error('body read timeout'))
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('body too large')
      chunks.push(chunk)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return Buffer.concat(chunks).toString('utf8')
}
