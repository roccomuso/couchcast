import { extname } from 'node:path'
import { silentLogger } from '../logger.js'
import { findFfprobe, runFfprobe, summarize } from './ffprobe.js'
import { mimeForExt, mimeForFormat } from './mime.js'
import { probeNative } from './native.js'

export * from './mime.js'

/**
 * @typedef {import('./ffprobe.js').ProbeSummary & { mime: string, probed: boolean }} MediaInfo
 * @typedef {{ path: string, size: number, mtimeMs: number }} FileRef
 */

/**
 * Media metadata. Uses ffprobe when installed; otherwise (or if ffprobe fails)
 * the built-in MP4/MKV readers; otherwise the extension alone.
 * Results are cached by path + mtime + size.
 */
export class Prober {
  /** @type {Map<string, MediaInfo>} */
  #cache = new Map()
  #ac = new AbortController()
  #bin
  #log
  #slots
  /** @type {Array<() => void>} */
  #waiting = []

  /**
   * @param {{ ffprobe?: string | null, concurrency?: number, logger?: import('../logger.js').Logger }} [opts]
   */
  constructor ({ ffprobe = null, concurrency = 4, logger = silentLogger } = {}) {
    this.#bin = ffprobe
    this.#slots = concurrency
    this.#log = logger.child('probe')
  }

  /**
   * @param {{ enabled?: boolean, logger?: import('../logger.js').Logger }} [opts]
   */
  static async create ({ enabled = true, logger = silentLogger } = {}) {
    const bin = enabled ? await findFfprobe() : null
    if (enabled && !bin) logger.child('probe').info('ffprobe not found: built-in metadata for MP4/MOV/MKV/WebM only (install ffmpeg for other formats)')
    return new Prober({ ffprobe: bin, logger })
  }

  /** Whether ffprobe is in use (the built-in readers are always available). */
  get ffprobe () { return this.#bin !== null }

  /** @param {FileRef} f */
  #key (f) { return `${f.path}\0${f.mtimeMs}\0${f.size}` }

  /**
   * Cached info if available, extension-based otherwise. Never spawns.
   * @param {FileRef} f
   * @returns {MediaInfo}
   */
  peek (f) {
    return this.#cache.get(this.#key(f)) ?? { mime: mimeForExt(extname(f.path).slice(1)), probed: false }
  }

  /**
   * @param {FileRef} f
   * @returns {Promise<MediaInfo>}
   */
  async probe (f) {
    const key = this.#key(f)
    const hit = this.#cache.get(key)
    if (hit) return hit
    const ext = extname(f.path).slice(1)
    if (this.#ac.signal.aborted) return this.peek(f)
    await this.#acquire()
    try {
      if (this.#ac.signal.aborted) return this.peek(f)
      const s = await this.#summarize(f.path)
      // Cache misses too, so an unsupported or broken file isn't re-read on every scan.
      if (!s) {
        const info = this.peek(f)
        this.#cache.set(key, info)
        return info
      }
      if (!s.bitrate && s.duration && f.size) s.bitrate = Math.round((f.size * 8) / s.duration)
      /** @type {MediaInfo} */
      const info = { ...s, mime: s.container ? mimeForFormat(s.container, ext) : mimeForExt(ext), probed: true }
      this.#cache.set(key, info)
      return info
    } finally {
      this.#release()
    }
  }

  /**
   * @param {string} path
   * @returns {Promise<import('./ffprobe.js').ProbeSummary | null>}
   */
  async #summarize (path) {
    if (this.#bin) {
      try {
        return summarize(await runFfprobe(this.#bin, path, { signal: this.#ac.signal }))
      } catch (err) {
        if (this.#ac.signal.aborted) return null
        this.#log.debug('%s', /** @type {Error} */ (err).message)
      }
    }
    try {
      return await probeNative(path)
    } catch (err) {
      this.#log.debug('cannot read metadata of %s: %s', path, /** @type {Error} */ (err).message)
      return null
    }
  }

  /** Kill in-flight ffprobe processes and refuse new ones. */
  stop () {
    this.#ac.abort()
    for (const wake of this.#waiting.splice(0)) wake()
  }

  async #acquire () {
    if (this.#slots > 0) { this.#slots--; return }
    await new Promise((resolve) => this.#waiting.push(() => resolve(undefined)))
  }

  #release () {
    const next = this.#waiting.shift()
    if (next) next()
    else this.#slots++
  }
}
