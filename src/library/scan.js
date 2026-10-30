import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { silentLogger } from '../logger.js'
import { VIDEO_EXTENSIONS } from '../probe/mime.js'
import { ROOT_ID, ROOT_PARENT_ID, objectId } from './ids.js'

/**
 * @typedef {{
 *   kind: 'container', id: string, parentId: string, title: string,
 *   path: string, relPath: string, mtimeMs: number, children: string[],
 * }} ContainerNode
 * @typedef {{
 *   kind: 'item', id: string, parentId: string, title: string,
 *   path: string, relPath: string, ext: string, size: number, mtimeMs: number,
 *   subtitle: { path: string, size: number, mtimeMs: number } | null,
 * }} ItemNode
 * @typedef {ContainerNode | ItemNode} LibraryNode
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** @param {LibraryNode} a @param {LibraryNode} b */
export const naturalOrder = (a, b) =>
  a.kind !== b.kind ? (a.kind === 'container' ? -1 : 1) : collator.compare(a.title, b.title)

/**
 * Walk `root` and build the object tree. Hidden entries (dot-prefixed) are
 * skipped, symlinks are followed with cycle protection, and folders without
 * any video (recursively) are pruned so TVs don't show empty folders.
 * @param {string} root absolute path
 * @param {{ title?: string, extensions?: Set<string>, logger?: import('../logger.js').Logger }} [opts]
 */
export async function scanDirectory (root, { title, extensions = VIDEO_EXTENSIONS, logger = silentLogger } = {}) {
  /** @type {Map<string, LibraryNode>} */
  const nodes = new Map()
  const visited = new Set([await realpath(root)])
  let videoCount = 0

  /** @type {ContainerNode} */
  const rootNode = {
    kind: 'container',
    id: ROOT_ID,
    parentId: ROOT_PARENT_ID,
    title: title ?? basename(root),
    path: root,
    relPath: '',
    mtimeMs: (await stat(root)).mtimeMs,
    children: [],
  }

  /**
   * @param {ContainerNode} container
   * @returns {Promise<boolean>} true if it contains at least one video
   */
  async function visit (container) {
    let entries
    try {
      entries = await readdir(container.path, { withFileTypes: true })
    } catch (err) {
      logger.warn('cannot read %s: %s', container.path, /** @type {Error} */ (err).message)
      return false
    }
    /** @type {Map<string, string>} lower-cased base name → .srt file name */
    const subtitles = new Map()
    for (const e of entries) {
      if (!e.name.startsWith('.') && extname(e.name).toLowerCase() === '.srt') {
        subtitles.set(e.name.slice(0, -4).toLowerCase(), e.name)
      }
    }

    /** @type {LibraryNode[]} */
    const children = []
    const results = await Promise.all(entries.map(async (e) => {
      if (e.name.startsWith('.')) return null
      const full = join(container.path, e.name)
      let st
      try {
        st = await stat(full) // follows symlinks
      } catch {
        return null // dangling symlink, permission error, raced deletion
      }
      const relPath = relative(root, full)
      if (st.isDirectory()) {
        let real
        try { real = await realpath(full) } catch { return null }
        if (visited.has(real)) return null
        visited.add(real)
        return /** @type {ContainerNode} */ ({
          kind: 'container',
          id: objectId(relPath),
          parentId: container.id,
          title: e.name,
          path: full,
          relPath,
          mtimeMs: st.mtimeMs,
          children: [],
        })
      }
      const ext = extname(e.name).slice(1).toLowerCase()
      if (!st.isFile() || !extensions.has(ext)) return null
      const base = e.name.slice(0, -(ext.length + 1))
      const srtName = subtitles.get(base.toLowerCase())
      let subtitle = null
      if (srtName) {
        try {
          const sst = await stat(join(container.path, srtName))
          subtitle = { path: join(container.path, srtName), size: sst.size, mtimeMs: sst.mtimeMs }
        } catch {}
      }
      return /** @type {ItemNode} */ ({
        kind: 'item',
        id: objectId(relPath),
        parentId: container.id,
        title: base,
        path: full,
        relPath,
        ext,
        size: st.size,
        mtimeMs: st.mtimeMs,
        subtitle,
      })
    }))

    // Sequential recursion keeps file-descriptor usage bounded on huge trees.
    for (const node of results) {
      if (!node) continue
      if (node.kind === 'container') {
        if (await visit(node)) children.push(node)
      } else {
        children.push(node)
        videoCount++
      }
    }
    children.sort(naturalOrder)
    for (const c of children) nodes.set(c.id, c)
    container.children = children.map((c) => c.id)
    return children.length > 0
  }

  await visit(rootNode)
  nodes.set(ROOT_ID, rootNode)
  return { nodes, videoCount }
}
