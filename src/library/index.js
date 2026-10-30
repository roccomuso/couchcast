import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { silentLogger } from '../logger.js'
import { Prober } from '../probe/index.js'
import { ROOT_ID } from './ids.js'
import { scanDirectory } from './scan.js'
import { watchTree } from './watch.js'

export { ROOT_ID, ID_PATTERN, objectId } from './ids.js'

/**
 * @typedef {import('./scan.js').LibraryNode} LibraryNode
 * @typedef {import('./scan.js').ItemNode} ItemNode
 * @typedef {import('./scan.js').ContainerNode} ContainerNode
 */

/**
 * In-memory video library for one directory tree.
 * Events: 'change' (structure changed after a rescan), 'probed' (metadata improved).
 */
export class Library extends EventEmitter {
  /** @type {Map<string, LibraryNode>} */
  #nodes = new Map()
  #fingerprint = ''
  #videoCount = 0
  /** @type {Promise<boolean> | null} */
  #scanning = null
  #rescanQueued = false
  /** @type {{ close: () => void } | null} */
  #watcher = null
  #stopped = false
  #root
  #title
  #prober
  #log

  /**
   * @param {{ root: string, title?: string, prober?: Prober, logger?: import('../logger.js').Logger }} opts
   */
  constructor ({ root, title, prober = new Prober(), logger = silentLogger }) {
    super()
    this.#root = root
    this.#title = title
    this.#prober = prober
    this.#log = logger.child('library')
  }

  get root () { return this.#root }
  get videoCount () { return this.#videoCount }

  /** @param {string} id */
  get (id) { return this.#nodes.get(id) }

  /**
   * Children of a container, in natural order. Empty for unknown IDs and items.
   * @param {string} id
   * @returns {LibraryNode[]}
   */
  children (id) {
    const node = this.#nodes.get(id)
    if (!node || node.kind !== 'container') return []
    return /** @type {LibraryNode[]} */ (node.children.map((c) => this.#nodes.get(c)).filter(Boolean))
  }

  /** @returns {Generator<ItemNode>} */
  * items () {
    for (const n of this.#nodes.values()) if (n.kind === 'item') yield n
  }

  /** @param {ItemNode} item */
  media (item) {
    return this.#prober.peek(item)
  }

  /**
   * Rescan the tree. Concurrent calls coalesce into at most one extra pass.
   * @returns {Promise<boolean>} whether the visible structure changed
   */
  async scan () {
    if (this.#scanning) {
      this.#rescanQueued = true
      return this.#scanning
    }
    this.#scanning = this.#doScan().finally(() => { this.#scanning = null })
    const changed = await this.#scanning
    if (this.#rescanQueued && !this.#stopped) {
      this.#rescanQueued = false
      return (await this.scan()) || changed
    }
    return changed
  }

  async #doScan () {
    const t0 = performance.now()
    const { nodes, videoCount } = await scanDirectory(this.#root, { title: this.#title, logger: this.#log })
    const fingerprint = fingerprintOf(nodes)
    const changed = fingerprint !== this.#fingerprint
    this.#nodes = nodes
    this.#videoCount = videoCount
    this.#fingerprint = fingerprint
    this.#log.debug('scanned %d videos in %dms', videoCount, Math.round(performance.now() - t0))
    if (changed) {
      this.emit('change')
      this.#probeAll().catch((err) => this.#log.warn('probing failed: %s', err.message))
    }
    return changed
  }

  /** Background metadata probe of all items; emits 'probed' once if anything new was learned. */
  async #probeAll () {
    let learned = 0
    await Promise.all([...this.items()].map(async (item) => {
      if (this.#prober.peek(item).probed) return
      if ((await this.#prober.probe(item)).probed) learned++
    }))
    if (learned > 0 && !this.#stopped) {
      this.#log.debug('probed %d files', learned)
      this.emit('probed')
    }
  }

  watch () {
    if (this.#watcher || this.#stopped) return
    this.#watcher = watchTree(this.#root, () => {
      this.scan().catch((err) => this.#log.warn('rescan failed: %s', err.message))
    }, { logger: this.#log })
  }

  stop () {
    this.#stopped = true
    this.#watcher?.close()
    this.#watcher = null
    this.#prober.stop()
  }
}

/** @param {Map<string, LibraryNode>} nodes */
function fingerprintOf (nodes) {
  const h = createHash('sha1')
  const root = nodes.get(ROOT_ID)
  /** @param {LibraryNode | undefined} n */
  const walk = (n) => {
    if (!n) return
    h.update(`${n.id}|${n.title}|`)
    if (n.kind === 'item') h.update(`${n.size}|${n.mtimeMs}|${n.subtitle?.mtimeMs ?? ''}\n`)
    else for (const c of n.children) walk(nodes.get(c))
  }
  walk(root)
  return h.digest('hex')
}
