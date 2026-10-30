import { open } from 'node:fs/promises'
import { probeMkv } from './mkv.js'
import { MP4_FIRST_BOXES, probeMp4 } from './mp4.js'

/**
 * Built-in metadata readers: no ffprobe needed for MP4/MOV/M4V/3GP and
 * MKV/WebM. The format is sniffed from magic bytes, not trusted from the
 * extension.
 * @param {string} path
 * @returns {Promise<import('./ffprobe.js').ProbeSummary | null>} null if the format is unsupported
 */
export async function probeNative (path) {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    /** @param {number} pos @param {number} len */
    const readAt = async (pos, len) => {
      const n = Math.max(0, Math.min(len, size - pos))
      const buf = Buffer.alloc(n)
      const { bytesRead } = await fh.read(buf, 0, n, pos)
      return buf.subarray(0, bytesRead)
    }
    const magic = await readAt(0, 8)
    if (magic.length < 8) return null
    if (magic.readUInt32BE(0) === 0x1A45DFA3) return await probeMkv(readAt, size)
    if (MP4_FIRST_BOXES.has(magic.toString('latin1', 4, 8))) return await probeMp4(readAt, size)
    return null
  } finally {
    await fh.close()
  }
}
