import { UpnpError, UpnpErrorCode } from '../errors.js'
import { ROOT_ID } from '../library/index.js'
import { didlLite } from './didl.js'

/**
 * @typedef {import('../library/index.js').Library} Library
 * @typedef {import('../library/index.js').LibraryNode} LibraryNode
 * @typedef {{ quirks: import('../quirks.js').Quirks, baseUrl: string }} ActionContext
 * @typedef {(args: Record<string, string>, ctx: ActionContext) => Record<string, string | number>} ActionHandler
 */

/** Sort keys we honor in SortCriteria → comparator over nodes. */
const SORT_KEYS = /** @type {Record<string, (a: LibraryNode, b: LibraryNode) => number>} */ ({
  'dc:title': (a, b) => collator.compare(a.title, b.title),
  'dc:date': (a, b) => a.mtimeMs - b.mtimeMs,
  'upnp:class': (a, b) => (a.kind === b.kind ? 0 : a.kind === 'container' ? -1 : 1),
  'res@size': (a, b) => (a.kind === 'item' ? a.size : 0) - (b.kind === 'item' ? b.size : 0),
})
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export const SORT_CAPS = Object.keys(SORT_KEYS).join(',')

/**
 * Parse "+dc:title,-dc:date". Unknown keys → 709, per spec.
 * @param {string} criteria
 * @returns {Array<{ key: string, desc: boolean }>}
 */
export function parseSortCriteria (criteria) {
  return criteria.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const desc = s.startsWith('-')
    const key = s.replace(/^[+-]/, '')
    if (!(key in SORT_KEYS)) throw new UpnpError(UpnpErrorCode.UNSUPPORTED_SORT, `Unsupported sort criteria: ${key}`)
    return { key, desc }
  })
}

/**
 * Stable sort; returns a new array.
 * @param {LibraryNode[]} nodes
 * @param {Array<{ key: string, desc: boolean }>} criteria
 */
export function sortNodes (nodes, criteria) {
  if (criteria.length === 0) return nodes
  return [...nodes].sort((a, b) => {
    for (const { key, desc } of criteria) {
      const r = SORT_KEYS[key](a, b)
      if (r !== 0) return desc ? -r : r
    }
    return 0
  })
}

/**
 * @param {string | undefined} v
 * @param {string} name
 */
function uint (v, name) {
  if (v === undefined || v === '') return 0
  if (!/^\d+$/.test(v)) throw new UpnpError(UpnpErrorCode.INVALID_ARGS, `Invalid ${name}`)
  return Number(v)
}

const FEATURE_LIST = `<?xml version="1.0" encoding="utf-8"?><Features xmlns="urn:schemas-upnp-org:av:avs" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:schemas-upnp-org:av:avs http://www.upnp.org/schemas/av/avs.xsd"><Feature name="samsung.com_BASICVIEW" version="1"><container id="${ROOT_ID}" type="object.item.videoItem"/></Feature></Features>`

/**
 * ContentDirectory:1 action handlers.
 * @param {{ library: Library, getUpdateId: () => number }} deps
 * @returns {Record<string, ActionHandler>}
 */
export function createContentDirectory ({ library, getUpdateId }) {
  return {
    Browse (args, { quirks, baseUrl }) {
      const { ObjectID, BrowseFlag, SortCriteria = '' } = args
      if (ObjectID === undefined || BrowseFlag === undefined) {
        throw new UpnpError(UpnpErrorCode.INVALID_ARGS, 'Missing ObjectID or BrowseFlag')
      }
      const start = uint(args.StartingIndex, 'StartingIndex')
      const count = uint(args.RequestedCount, 'RequestedCount')
      const node = library.get(ObjectID)
      if (!node) throw new UpnpError(UpnpErrorCode.NO_SUCH_OBJECT, 'No such object')
      const didlOpts = {
        baseUrl,
        quirks,
        childCount: (/** @type {string} */ id) => library.children(id).length,
        media: library.media.bind(library),
      }

      if (BrowseFlag === 'BrowseMetadata') {
        return { Result: didlLite([node], didlOpts), NumberReturned: 1, TotalMatches: 1, UpdateID: getUpdateId() }
      }
      if (BrowseFlag !== 'BrowseDirectChildren') {
        throw new UpnpError(UpnpErrorCode.INVALID_ARGS, 'Invalid BrowseFlag')
      }
      if (node.kind !== 'container') throw new UpnpError(UpnpErrorCode.NO_SUCH_CONTAINER, 'No such container')
      const all = sortNodes(library.children(ObjectID), parseSortCriteria(SortCriteria))
      const page = all.slice(start, count > 0 ? start + count : undefined)
      return {
        Result: didlLite(page, didlOpts),
        NumberReturned: page.length,
        TotalMatches: all.length,
        UpdateID: getUpdateId(),
      }
    },
    GetSearchCapabilities: () => ({ SearchCaps: '' }),
    GetSortCapabilities: () => ({ SortCaps: SORT_CAPS }),
    GetSystemUpdateID: () => ({ Id: getUpdateId() }),
    X_GetFeatureList: () => ({ FeatureList: FEATURE_LIST }),
  }
}
