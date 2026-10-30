/**
 * Minimal ISO-BMFF (MP4/MOV/M4V/3GP) metadata reader: duration from `mvhd`,
 * dimensions/codecs/audio format from each `trak`. Reads box headers plus
 * the `moov` box only, wherever it sits in the file (start or end).
 */

/** Box types that may legitimately open an MP4/MOV file. */
export const MP4_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid'])

const MAX_MOOV = 64 * 1024 * 1024
const MAX_TOP_LEVEL_BOXES = 1024

const VIDEO_CODECS = /** @type {Record<string, string>} */ ({
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  dvh1: 'hevc',
  dvhe: 'hevc',
  av01: 'av1',
  vp09: 'vp9',
  vp08: 'vp8',
  mp4v: 'mpeg4',
  jpeg: 'mjpeg',
  apcn: 'prores',
  apch: 'prores',
  apcs: 'prores',
  apco: 'prores',
  ap4h: 'prores',
})
const AUDIO_CODECS = /** @type {Record<string, string>} */ ({
  mp4a: 'aac',
  'ac-3': 'ac3',
  'ec-3': 'eac3',
  Opus: 'opus',
  fLaC: 'flac',
  alac: 'alac',
  '.mp3': 'mp3',
  lpcm: 'pcm',
  sowt: 'pcm',
  twos: 'pcm',
})

/**
 * @typedef {import('./ffprobe.js').ProbeSummary} ProbeSummary
 * @typedef {{ type: string, start: number, body: number, end: number }} Box
 * @typedef {(pos: number, len: number) => Promise<Buffer>} ReadAt
 */

/**
 * Parse one box header at `pos` of `buf`. `limit` is the end of the enclosing range.
 * @param {Buffer} buf
 * @param {number} pos
 * @param {number} limit
 * @returns {{ type: string, header: number, size: number } | null}
 */
function boxHeader (buf, pos, limit) {
  if (pos + 8 > buf.length) return null
  let size = buf.readUInt32BE(pos)
  const type = buf.toString('latin1', pos + 4, pos + 8)
  let header = 8
  if (size === 1) {
    if (pos + 16 > buf.length) return null
    size = Number(buf.readBigUInt64BE(pos + 8))
    header = 16
  } else if (size === 0) {
    size = limit - pos // box extends to the end of its container
  }
  return size < header ? null : { type, header, size }
}

/**
 * Iterate child boxes of a buffer range. Stops on malformed sizes.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {Generator<Box>}
 */
function * children (buf, start, end) {
  let pos = start
  while (pos + 8 <= end) {
    const h = boxHeader(buf, pos, end)
    if (!h || pos + h.size > end) return
    yield { type: h.type, start: pos, body: pos + h.header, end: pos + h.size }
    pos += h.size
  }
}

/**
 * @param {Buffer} buf
 * @param {Box} parent
 * @param {...string} path
 * @returns {Box | undefined}
 */
function find (buf, parent, ...path) {
  let cur = parent
  for (const type of path) {
    let next
    for (const b of children(buf, cur.body, cur.end)) {
      if (b.type === type) { next = b; break }
    }
    if (!next) return undefined
    cur = next
  }
  return cur
}

/**
 * Parse an in-memory `moov` box (starting with its own header).
 * @param {Buffer} buf
 * @returns {ProbeSummary}
 */
export function parseMoov (buf) {
  const root = children(buf, 0, buf.length).next().value
  if (!root || root.type !== 'moov') return {}
  /** @type {ProbeSummary} */
  const out = { container: 'mov,mp4,m4a,3gp,3g2,mj2' }

  const mvhd = find(buf, root, 'mvhd')
  if (mvhd && mvhd.body + 32 <= mvhd.end) {
    // v0: version/flags(4) creation(4) modification(4) timescale(4) duration(4)
    // v1: version/flags(4) creation(8) modification(8) timescale(4) duration(8)
    const v1 = buf[mvhd.body] === 1
    const timescale = buf.readUInt32BE(mvhd.body + (v1 ? 20 : 12))
    const duration = v1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16)
    // 0xFFFFFFFF = unknown; 0 = fragmented MP4 (duration lives in the fragments).
    if (timescale > 0 && duration > 0 && duration !== 0xFFFFFFFF) out.duration = duration / timescale
  }

  for (const trak of children(buf, root.body, root.end)) {
    if (trak.type !== 'trak') continue
    const hdlr = find(buf, trak, 'mdia', 'hdlr')
    const handler = hdlr && hdlr.body + 12 <= hdlr.end ? buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) : ''
    const stsd = find(buf, trak, 'mdia', 'minf', 'stbl', 'stsd')
    // stsd: version/flags(4) entry_count(4), then the first sample entry: size(4) format(4) ...
    const entry = stsd && stsd.body + 16 <= stsd.end ? stsd.body + 8 : -1
    const entryEnd = stsd?.end ?? 0
    const format = entry >= 0 ? buf.toString('latin1', entry + 4, entry + 8) : ''

    if (handler === 'vide' && out.videoCodec === undefined) {
      out.videoCodec = VIDEO_CODECS[format] ?? (format.trim() || undefined)
      const tkhd = find(buf, trak, 'tkhd')
      if (tkhd) {
        // After the version-dependent times (24 or 36 bytes): reserved(8) layer(2)
        // alt_group(2) volume(2) reserved(2) matrix(36), then width/height as 16.16.
        const at = tkhd.body + (buf[tkhd.body] === 1 ? 36 : 24) + 52
        if (at + 8 <= tkhd.end) {
          out.width = (buf.readUInt32BE(at) >>> 16) || undefined
          out.height = (buf.readUInt32BE(at + 4) >>> 16) || undefined
        }
      }
      // Fallback: coded size from the visual sample entry (width @32, height @34).
      if ((!out.width || !out.height) && entry >= 0 && entry + 36 <= entryEnd) {
        out.width = buf.readUInt16BE(entry + 32) || undefined
        out.height = buf.readUInt16BE(entry + 34) || undefined
      }
    } else if (handler === 'soun' && out.audioCodec === undefined) {
      out.audioCodec = AUDIO_CODECS[format] ?? (format.trim() || undefined)
      // Audio sample entry: ... version(2) revision(2) vendor(4) channels(2) sample_size(2)
      // pre_defined(2) reserved(2) sample_rate(16.16).
      if (entry >= 0 && entry + 36 <= entryEnd) {
        out.audioChannels = buf.readUInt16BE(entry + 24) || undefined
        out.sampleRate = (buf.readUInt32BE(entry + 32) >>> 16) || undefined
      }
    }
  }
  return out
}

/**
 * Locate and parse `moov` by walking top-level box headers (skipping `mdat`).
 * @param {ReadAt} readAt
 * @param {number} fileSize
 * @returns {Promise<ProbeSummary | null>} null if this is not an MP4/MOV file
 */
export async function probeMp4 (readAt, fileSize) {
  let pos = 0
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && pos + 8 <= fileSize; i++) {
    const head = await readAt(pos, 16)
    const h = boxHeader(head, 0, fileSize - pos)
    if (!h) return null
    if (i === 0 && !MP4_FIRST_BOXES.has(h.type)) return null
    if (h.type === 'moov') {
      if (h.size > MAX_MOOV || pos + h.size > fileSize) return null
      return parseMoov(await readAt(pos, h.size))
    }
    pos += h.size
  }
  return null
}
