import { RangeNotSatisfiableError } from '../errors.js'

/**
 * Parse a single-range `Range` header (RFC 9110 §14.1.2).
 * - Absent or syntactically invalid → null (serve the whole file, as the RFC allows).
 * - Multiple ranges → only the first is honored (what DLNA clients actually send).
 * - Unsatisfiable → throws RangeNotSatisfiableError (caller answers 416).
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null} inclusive byte offsets
 */
export function parseRange (header, size) {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(header)
  if (!m || (m[1] === '' && m[2] === '')) return null
  const first = m[1] === '' ? null : Number(m[1])
  const last = m[2] === '' ? null : Number(m[2])
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null

  if (first === null) {
    // Suffix range: last N bytes.
    if (last === 0 || size === 0) throw new RangeNotSatisfiableError(size)
    return { start: Math.max(0, size - /** @type {number} */ (last)), end: size - 1 }
  }
  if (last !== null && last < first) return null
  if (first >= size) throw new RangeNotSatisfiableError(size)
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) }
}
