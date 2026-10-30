/** Extension → MIME. The keys define what the library indexes as "video". */
export const VIDEO_MIME = Object.freeze(/** @type {Record<string, string>} */ ({
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  vob: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  ogv: 'video/ogg',
}))

export const VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_MIME))
export const SUBTITLE_MIME = 'text/srt'

/**
 * DLNA.ORG_FLAGS: streaming transfer mode + background transfer mode +
 * connection stall + DLNA v1.5 (0x01700000), padded to 32 hex digits.
 */
export const DLNA_FLAGS = '01700000000000000000000000000000'

/** @param {string} ext extension without the dot, any case */
export function mimeForExt (ext) {
  return VIDEO_MIME[ext.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Refine the MIME using ffprobe's `format_name`, for files whose extension lies.
 * @param {string} formatName e.g. "mov,mp4,m4a,3gp,3g2,mj2"
 * @param {string} ext
 */
export function mimeForFormat (formatName, ext) {
  const byExt = mimeForExt(ext)
  const f = formatName.split(',')
  if (f.includes('matroska') || f.includes('webm')) return ext.toLowerCase() === 'webm' ? 'video/webm' : 'video/x-matroska'
  if (f.includes('mp4') || f.includes('mov')) return byExt === 'video/quicktime' || byExt === 'video/mp4' || byExt === 'video/3gpp' ? byExt : 'video/mp4'
  if (f.includes('avi')) return 'video/x-msvideo'
  if (f.includes('mpegts')) return 'video/mp2t'
  if (f.includes('mpeg') || f.includes('mpegvideo')) return 'video/mpeg'
  if (f.includes('asf')) return 'video/x-ms-wmv'
  if (f.includes('flv')) return 'video/x-flv'
  if (f.includes('ogg')) return 'video/ogg'
  return byExt
}

/**
 * 4th field of protocolInfo; also the value of the contentFeatures.dlna.org header.
 * OP=01: byte-range seek only (no TimeSeekRange). CI=0: not transcoded.
 * @param {{ profile?: string }} [opts] DLNA.ORG_PN, only when we are sure of it
 */
export function dlnaFeatures ({ profile } = {}) {
  return `${profile ? `DLNA.ORG_PN=${profile};` : ''}DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`
}

/**
 * @param {string} mime
 * @param {{ profile?: string }} [opts]
 */
export function protocolInfo (mime, opts) {
  return `http-get:*:${mime}:${dlnaFeatures(opts)}`
}

/** SourceProtocolInfo for ConnectionManager: everything we may serve. */
export function sourceProtocolInfo () {
  const mimes = new Set([...Object.values(VIDEO_MIME), 'video/x-mkv'])
  return [...[...mimes].map((m) => protocolInfo(m)), `http-get:*:${SUBTITLE_MIME}:*`].join(',')
}
