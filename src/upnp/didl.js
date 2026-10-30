import { protocolInfo } from '../probe/mime.js'
import { DEFAULT_QUIRKS } from '../quirks.js'
import { raw, xml } from './xml.js'

/**
 * @typedef {import('../library/scan.js').LibraryNode} LibraryNode
 * @typedef {import('../library/scan.js').ItemNode} ItemNode
 * @typedef {import('../probe/index.js').MediaInfo} MediaInfo
 * @typedef {{
 *   baseUrl: string,
 *   childCount: (id: string) => number,
 *   media: (item: ItemNode) => MediaInfo,
 *   quirks?: import('../quirks.js').Quirks,
 * }} DidlOptions
 */

const DIDL_OPEN = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/" xmlns:sec="http://www.sec.co.kr/">'
const DIDL_CLOSE = '</DIDL-Lite>'

/** @param {ItemNode} item @param {string} baseUrl */
export const mediaUrl = (item, baseUrl) => `${baseUrl}/media/${item.id}.${item.ext}`
/** @param {ItemNode} item @param {string} baseUrl */
export const subtitleUrl = (item, baseUrl) => `${baseUrl}/subs/${item.id}.srt`

/**
 * UPnP duration: H+:MM:SS.F
 * @param {number} seconds
 */
export function formatDuration (seconds) {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = Math.floor(ms / 1000) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

/** @param {number} ms */
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 19)

/**
 * Effective MIME for a client, after quirks.
 * @param {MediaInfo} media
 * @param {import('../quirks.js').Quirks} quirks
 */
export const mimeFor = (media, quirks) => quirks.mimeAliases[media.mime] ?? media.mime

/**
 * @param {LibraryNode} node
 * @param {DidlOptions} opts
 */
function renderNode (node, { baseUrl, childCount, media, quirks = DEFAULT_QUIRKS }) {
  if (node.kind === 'container') {
    return xml`<container id="${node.id}" parentID="${node.parentId}" restricted="1" searchable="0" childCount="${childCount(node.id)}"><dc:title>${node.title}</dc:title><upnp:class>object.container.storageFolder</upnp:class><upnp:storageUsed>-1</upnp:storageUsed></container>`
  }
  const info = media(node)
  /** @type {string[]} */
  const attrs = [xml`protocolInfo="${protocolInfo(mimeFor(info, quirks))}"`.value, `size="${node.size}"`]
  if (info.duration) attrs.push(`duration="${formatDuration(info.duration)}"`)
  if (info.width && info.height) attrs.push(`resolution="${info.width}x${info.height}"`)
  // res@bitrate is in bytes per second (UPnP AV), ffprobe reports bits.
  if (info.bitrate) attrs.push(`bitrate="${Math.round(info.bitrate / 8)}"`)
  if (info.audioChannels) attrs.push(`nrAudioChannels="${info.audioChannels}"`)
  if (info.sampleRate) attrs.push(`sampleFrequency="${info.sampleRate}"`)

  const parts = [
    xml`<dc:title>${node.title}</dc:title>`,
    raw('<upnp:class>object.item.videoItem</upnp:class>'),
    xml`<dc:date>${isoDate(node.mtimeMs)}</dc:date>`,
    xml`<res ${raw(attrs.join(' '))}>${mediaUrl(node, baseUrl)}</res>`,
  ]
  if (node.subtitle) {
    const url = subtitleUrl(node, baseUrl)
    if (quirks.subtitleRes) parts.push(xml`<res protocolInfo="http-get:*:${quirks.subtitleMime}:*">${url}</res>`)
    if (quirks.captionInfoEx) parts.push(xml`<sec:CaptionInfoEx sec:type="srt">${url}</sec:CaptionInfoEx>`)
  }
  return xml`<item id="${node.id}" parentID="${node.parentId}" restricted="1">${parts}</item>`
}

/**
 * Serialize nodes into a DIDL-Lite document (unescaped: the SOAP layer escapes it once more).
 * @param {LibraryNode[]} nodes
 * @param {DidlOptions} opts
 */
export function didlLite (nodes, opts) {
  return DIDL_OPEN + nodes.map((n) => renderNode(n, opts).value).join('') + DIDL_CLOSE
}
