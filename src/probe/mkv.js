/**
 * Minimal Matroska/WebM (EBML) metadata reader: duration from Segment/Info,
 * dimensions/codecs/audio format from Segment/Tracks. Walks top-level Segment
 * children by header, reading only Info and Tracks bodies; stops at the first
 * Cluster (media data), so large Attachments or Cues are skipped, not read.
 */

const ID = {
  EBML: 0x1A45DFA3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549A966,
  TimecodeScale: 0x2AD7B1,
  Duration: 0x4489,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xE0,
  PixelWidth: 0xB0,
  PixelHeight: 0xBA,
  Audio: 0xE1,
  SamplingFrequency: 0xB5,
  Channels: 0x9F,
  Cluster: 0x1F43B675,
}

const MAX_ELEMENT_BODY = 4 * 1024 * 1024
const MAX_SEGMENT_CHILDREN = 256
const HEADER_PEEK = 12 // max ID (4) + max size (8)

/** Matroska CodecID prefix → ffprobe-style codec name. */
const CODECS = /** @type {Array<[string, string]>} */ ([
  ['V_MPEG4/ISO/AVC', 'h264'],
  ['V_MPEGH/ISO/HEVC', 'hevc'],
  ['V_AV1', 'av1'],
  ['V_VP9', 'vp9'],
  ['V_VP8', 'vp8'],
  ['V_MPEG4/ISO', 'mpeg4'],
  ['V_MS/VFW/FOURCC', 'msvfw'],
  ['V_MPEG2', 'mpeg2video'],
  ['V_MPEG1', 'mpeg1video'],
  ['V_THEORA', 'theora'],
  ['A_AAC', 'aac'],
  ['A_EAC3', 'eac3'],
  ['A_AC3', 'ac3'],
  ['A_DTS', 'dts'],
  ['A_TRUEHD', 'truehd'],
  ['A_OPUS', 'opus'],
  ['A_VORBIS', 'vorbis'],
  ['A_FLAC', 'flac'],
  ['A_MPEG/L3', 'mp3'],
  ['A_MPEG/L2', 'mp2'],
  ['A_PCM', 'pcm'],
])

/**
 * @typedef {import('./ffprobe.js').ProbeSummary} ProbeSummary
 * @typedef {(pos: number, len: number) => Promise<Buffer>} ReadAt
 * @typedef {{ id: number, header: number, size: number | null }} ElementHeader size null = unknown
 */

/**
 * Read an EBML variable-length integer.
 * @param {Buffer} buf
 * @param {number} pos
 * @param {boolean} keepMarker true for element IDs, false for sizes
 * @returns {{ value: number, len: number, unknown: boolean } | null}
 */
export function readVint (buf, pos, keepMarker) {
  const first = buf[pos]
  if (first === undefined || first === 0) return null
  let len = 1
  let mask = 0x80
  while (!(first & mask)) { mask >>= 1; len++ }
  if (pos + len > buf.length) return null
  let value = keepMarker ? first : first & (mask - 1)
  let allOnes = (first & (mask - 1)) === mask - 1
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i]
    if (buf[pos + i] !== 0xFF) allOnes = false
  }
  return { value, len, unknown: !keepMarker && allOnes }
}

/**
 * @param {Buffer} buf
 * @param {number} pos
 * @returns {ElementHeader | null}
 */
function elementHeader (buf, pos) {
  const id = readVint(buf, pos, true)
  if (!id || id.len > 4) return null
  const size = readVint(buf, pos + id.len, false)
  if (!size) return null
  return { id: id.value, header: id.len + size.len, size: size.unknown ? null : size.value }
}

/**
 * Iterate child elements in a buffer range.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {Generator<{ id: number, body: number, end: number }>}
 */
function * elements (buf, start, end) {
  let pos = start
  while (pos < end) {
    const h = elementHeader(buf, pos)
    if (!h) return
    const body = pos + h.header
    const stop = h.size === null ? end : body + h.size
    if (stop > end) return
    yield { id: h.id, body, end: stop }
    pos = stop
  }
}

/** @param {Buffer} buf @param {number} start @param {number} end */
const uint = (buf, start, end) => {
  let v = 0
  for (let i = start; i < end; i++) v = v * 256 + buf[i]
  return v
}
/** @param {Buffer} buf @param {number} start @param {number} end */
const float = (buf, start, end) =>
  end - start === 4 ? buf.readFloatBE(start) : end - start === 8 ? buf.readDoubleBE(start) : 0

/** @param {string} codecId */
const codecName = (codecId) => CODECS.find(([prefix]) => codecId.startsWith(prefix))?.[1] ?? (codecId || undefined)

/**
 * @param {Buffer} buf Info body
 * @param {ProbeSummary} out
 */
function parseInfo (buf, out) {
  let scale = 1_000_000 // default TimecodeScale: 1ms
  let duration = 0
  for (const e of elements(buf, 0, buf.length)) {
    if (e.id === ID.TimecodeScale) scale = uint(buf, e.body, e.end)
    else if (e.id === ID.Duration) duration = float(buf, e.body, e.end)
  }
  if (duration > 0 && scale > 0) out.duration = (duration * scale) / 1e9
}

/**
 * @param {Buffer} buf Tracks body
 * @param {ProbeSummary} out
 */
function parseTracks (buf, out) {
  for (const entry of elements(buf, 0, buf.length)) {
    if (entry.id !== ID.TrackEntry) continue
    let type = 0
    let codec = ''
    /** @type {{ body: number, end: number } | null} */
    let video = null
    /** @type {{ body: number, end: number } | null} */
    let audio = null
    for (const e of elements(buf, entry.body, entry.end)) {
      if (e.id === ID.TrackType) type = uint(buf, e.body, e.end)
      else if (e.id === ID.CodecID) codec = buf.toString('latin1', e.body, e.end).replace(/\0+$/, '')
      else if (e.id === ID.Video) video = e
      else if (e.id === ID.Audio) audio = e
    }
    if (type === 1 && out.videoCodec === undefined) {
      out.videoCodec = codecName(codec)
      if (video) {
        for (const e of elements(buf, video.body, video.end)) {
          if (e.id === ID.PixelWidth) out.width = uint(buf, e.body, e.end) || undefined
          else if (e.id === ID.PixelHeight) out.height = uint(buf, e.body, e.end) || undefined
        }
      }
    } else if (type === 2 && out.audioCodec === undefined) {
      out.audioCodec = codecName(codec)
      out.audioChannels = 1 // Matroska default when Channels is absent
      out.sampleRate = 8000 // Matroska default when SamplingFrequency is absent
      if (audio) {
        for (const e of elements(buf, audio.body, audio.end)) {
          if (e.id === ID.Channels) out.audioChannels = uint(buf, e.body, e.end) || undefined
          else if (e.id === ID.SamplingFrequency) out.sampleRate = Math.round(float(buf, e.body, e.end)) || undefined
        }
      }
    }
  }
}

/**
 * @param {ReadAt} readAt
 * @param {number} fileSize
 * @returns {Promise<ProbeSummary | null>} null if this is not a Matroska/WebM file
 */
export async function probeMkv (readAt, fileSize) {
  const head = await readAt(0, HEADER_PEEK)
  const ebml = elementHeader(head, 0)
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null || ebml.size > 4096) return null
  const ebmlBody = await readAt(ebml.header, ebml.size)
  let docType = ''
  for (const e of elements(ebmlBody, 0, ebmlBody.length)) {
    if (e.id === ID.DocType) docType = ebmlBody.toString('latin1', e.body, e.end)
  }
  if (docType !== 'matroska' && docType !== 'webm') return null

  /** @type {ProbeSummary} */
  const out = { container: 'matroska,webm' }
  const segPos = ebml.header + ebml.size
  const seg = elementHeader(await readAt(segPos, HEADER_PEEK), 0)
  if (!seg || seg.id !== ID.Segment) return out
  const segEnd = seg.size === null ? fileSize : Math.min(fileSize, segPos + seg.header + seg.size)

  let pos = segPos + seg.header
  let seenInfo = false
  let seenTracks = false
  for (let i = 0; i < MAX_SEGMENT_CHILDREN && pos < segEnd && !(seenInfo && seenTracks); i++) {
    const h = elementHeader(await readAt(pos, HEADER_PEEK), 0)
    if (!h || h.id === ID.Cluster || h.size === null) break
    const body = pos + h.header
    if ((h.id === ID.Info || h.id === ID.Tracks) && h.size <= MAX_ELEMENT_BODY) {
      const buf = await readAt(body, h.size)
      if (h.id === ID.Info) { parseInfo(buf, out); seenInfo = true } else { parseTracks(buf, out); seenTracks = true }
    }
    pos = body + h.size
  }
  return out
}
