import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { readVint } from '../../src/probe/mkv.js'
import { parseMoov } from '../../src/probe/mp4.js'
import { probeNative } from '../../src/probe/native.js'
import { Prober } from '../../src/probe/index.js'
import { mediaTree } from '../helpers/fixtures.js'

// ---------- MP4 builders ----------

/** @param {string} type @param {...Buffer} payload */
function box (type, ...payload) {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
/** @param {number} n */
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
/** @param {number} n */
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
/** @param {number} n */
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
const zeros = (/** @type {number} */ n) => Buffer.alloc(n)

/** @param {{ timescale: number, duration: number, v1?: boolean }} o */
const mvhd = ({ timescale, duration, v1 = false }) => v1
  ? box('mvhd', Buffer.from([1, 0, 0, 0]), u64(0), u64(0), u32(timescale), u64(duration), zeros(80))
  : box('mvhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(duration), zeros(80))

/** @param {number} w @param {number} h */
const tkhd = (w, h) => box('tkhd', Buffer.from([0, 0, 0, 3]), u32(0), u32(0), u32(1), u32(0), u32(0), zeros(16), zeros(36), u32(w * 65536), u32(h * 65536))
/** @param {string} handler */
const hdlr = (handler) => box('hdlr', zeros(4), zeros(4), Buffer.from(handler, 'latin1'), zeros(12), Buffer.from('h\0'))
/** @param {Buffer} entry */
const stsd = (entry) => box('stsd', zeros(4), u32(1), entry)
/** @param {string} type @param {Buffer} hdlrBox @param {Buffer} entry @param {Buffer} [tk] */
const trak = (type, hdlrBox, entry, tk) => box('trak', ...(tk ? [tk] : []), box('mdia', hdlrBox, box('minf', box('stbl', stsd(entry)))))

const videoEntry = (/** @type {string} */ fmt, w = 0, h = 0) => box(fmt, zeros(6), u16(1), zeros(16), u16(w), u16(h), zeros(50))
const audioEntry = (/** @type {string} */ fmt, ch = 2, rate = 48000) => box(fmt, zeros(6), u16(1), zeros(8), u16(ch), u16(16), zeros(4), u32(rate * 65536))

const moov = (/** @type {Buffer[]} */ ...extra) => box('moov',
  mvhd({ timescale: 1000, duration: 5_025_500 }),
  trak('vide', hdlr('vide'), videoEntry('avc1'), tkhd(1920, 1080)),
  trak('soun', hdlr('soun'), audioEntry('mp4a', 6, 44100)),
  ...extra
)
const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41'))

// ---------- EBML builders ----------

/** @param {number} id @param {...Buffer} payload */
function el (id, ...payload) {
  const body = Buffer.concat(payload)
  const idBytes = Buffer.from(id.toString(16).padStart(id > 0xFFFFFF ? 8 : id > 0xFFFF ? 6 : id > 0xFF ? 4 : 2, '0'), 'hex')
  const size = Buffer.alloc(8)
  size.writeBigUInt64BE(BigInt(body.length) | (1n << 56n)) // 8-byte vint
  return Buffer.concat([idBytes, size, body])
}
const unknownSize = Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
const str = (/** @type {string} */ s) => Buffer.from(s, 'latin1')
const f64 = (/** @type {number} */ n) => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
const f32 = (/** @type {number} */ n) => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b }
const uintb = (/** @type {number} */ n, bytes = 2) => { const b = Buffer.alloc(bytes); b.writeUIntBE(n, 0, bytes); return b }

/** @param {{ docType?: string, unknownSize?: boolean, attachmentBytes?: number }} [o] */
function mkv ({ docType = 'matroska', unknownSize: unk = true, attachmentBytes = 0 } = {}) {
  const header = el(0x1A45DFA3, el(0x4286, uintb(1, 1)), el(0x4282, str(docType)))
  const children = Buffer.concat([
    el(0x114D9B74, zeros(20)), // SeekHead
    el(0xEC, zeros(100)), // Void
    attachmentBytes ? el(0x1941A469, zeros(attachmentBytes)) : Buffer.alloc(0),
    el(0x1549A966, el(0x2AD7B1, uintb(1_000_000, 3)), el(0x4489, f64(5_025_500))),
    el(0x1654AE6B,
      el(0xAE, el(0xD7, uintb(1, 1)), el(0x83, uintb(1, 1)), el(0x86, str('V_MPEGH/ISO/HEVC')),
        el(0xE0, el(0xB0, uintb(3840)), el(0xBA, uintb(2160)))),
      el(0xAE, el(0xD7, uintb(2, 1)), el(0x83, uintb(2, 1)), el(0x86, str('A_EAC3')),
        el(0xE1, el(0xB5, f32(48000)), el(0x9F, uintb(6, 1))))),
    el(0x1F43B675, zeros(64)), // Cluster
  ])
  const segment = unk
    ? Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67]), unknownSize, children])
    : el(0x18538067, children)
  return Buffer.concat([header, segment])
}

describe('MP4 reader', () => {
  it('parses duration, dimensions, codecs and audio format', () => {
    assert.deepEqual(parseMoov(moov()), {
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: 5025.5,
      videoCodec: 'h264',
      width: 1920,
      height: 1080,
      audioCodec: 'aac',
      audioChannels: 6,
      sampleRate: 44100,
    })
  })

  it('handles mvhd v1 (64-bit duration)', () => {
    const m = box('moov', mvhd({ timescale: 90000, duration: 90000 * 7200, v1: true }))
    assert.equal(parseMoov(m).duration, 7200)
  })

  it('falls back to the sample-entry size when tkhd is missing', () => {
    const m = box('moov', trak('vide', hdlr('vide'), videoEntry('hvc1', 1280, 720)))
    const s = parseMoov(m)
    assert.equal(s.videoCodec, 'hevc')
    assert.equal(s.width, 1280)
    assert.equal(s.height, 720)
  })

  it('ignores unknown (0xFFFFFFFF) and fragmented (0) durations', () => {
    assert.equal(parseMoov(box('moov', mvhd({ timescale: 1000, duration: 0xFFFFFFFF }))).duration, undefined)
    assert.equal(parseMoov(box('moov', mvhd({ timescale: 1000, duration: 0 }))).duration, undefined)
  })
})

describe('EBML vint', () => {
  it('reads IDs with marker and sizes without', () => {
    assert.deepEqual(readVint(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), 0, true), { value: 0x1A45DFA3, len: 4, unknown: false })
    assert.deepEqual(readVint(Buffer.from([0x81]), 0, false), { value: 1, len: 1, unknown: false })
    assert.deepEqual(readVint(Buffer.from([0x40, 0x02]), 0, false), { value: 2, len: 2, unknown: false })
    assert.equal(readVint(Buffer.from([0xFF]), 0, false)?.unknown, true)
    assert.equal(readVint(unknownSize, 0, false)?.unknown, true)
    assert.equal(readVint(Buffer.from([0x00]), 0, false), null)
    assert.equal(readVint(Buffer.from([0x40]), 0, false), null, 'truncated')
  })
})

describe('probeNative (files)', () => {
  /** @type {Awaited<ReturnType<typeof mediaTree>>} */
  let tree
  const mdat = box('mdat', zeros(200_000))

  before(async () => {
    tree = await mediaTree({
      'faststart.mp4': Buffer.concat([ftyp, moov(), mdat]),
      'moov-at-end.mov': Buffer.concat([ftyp, mdat, moov()]),
      'lying-extension.mp4': mkv({ docType: 'webm' }), // actually WebM
      'movie.mkv': mkv(),
      'sized-segment.mkv': mkv({ unknownSize: false }),
      'with-attachment.mkv': mkv({ attachmentBytes: 300_000 }),
      'random.avi': Buffer.from('RIFF\0\0\0\0AVI LIST'),
      'garbage.mp4': Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 1, 2]), // ftyp, truncated
      'empty.mkv': Buffer.alloc(0),
    })
  })
  after(() => tree.cleanup())

  const probe = (/** @type {string} */ name) => probeNative(join(tree.root, name))

  it('MP4 with moov first or last', async () => {
    for (const name of ['faststart.mp4', 'moov-at-end.mov']) {
      const s = await probe(name)
      assert.equal(s?.duration, 5025.5, name)
      assert.equal(s?.width, 1920, name)
      assert.equal(s?.videoCodec, 'h264', name)
    }
  })

  it('Matroska with unknown/known segment size, skipping big elements', async () => {
    for (const name of ['movie.mkv', 'sized-segment.mkv', 'with-attachment.mkv']) {
      assert.deepEqual(await probe(name), {
        container: 'matroska,webm',
        duration: 5025.5,
        videoCodec: 'hevc',
        width: 3840,
        height: 2160,
        audioCodec: 'eac3',
        audioChannels: 6,
        sampleRate: 48000,
      }, name)
    }
  })

  it('sniffs content, not extension', async () => {
    assert.equal((await probe('lying-extension.mp4'))?.container, 'matroska,webm')
  })

  it('unsupported, truncated or empty files → null, never throws', async () => {
    assert.equal(await probe('random.avi'), null)
    assert.equal(await probe('garbage.mp4'), null)
    assert.equal(await probe('empty.mkv'), null)
  })

  it('Prober without ffprobe uses the built-in readers and derives bitrate', async () => {
    const prober = new Prober({ ffprobe: null })
    const file = { path: join(tree.root, 'lying-extension.mp4'), size: 1_000_000, mtimeMs: 1 }
    const info = await prober.probe(file)
    assert.equal(info.probed, true)
    assert.equal(info.mime, 'video/x-matroska', 'container wins over the .mp4 extension')
    assert.equal(info.bitrate, Math.round((1_000_000 * 8) / 5025.5))
    assert.equal(prober.peek(file), info, 'cached')

    const miss = await prober.probe({ path: join(tree.root, 'random.avi'), size: 1, mtimeMs: 1 })
    assert.deepEqual(miss, { mime: 'video/x-msvideo', probed: false })
    prober.stop()
  })
})
