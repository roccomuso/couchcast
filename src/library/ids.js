import { createHash } from 'node:crypto'
import { sep } from 'node:path'

export const ROOT_ID = '0'
export const ROOT_PARENT_ID = '-1'

/**
 * Stable object ID for a path relative to the served root. Same file → same
 * ID across rescans and restarts, so TVs can resume and keep bookmarks.
 * 96 bits of SHA-1 in base64url: URL-safe and collision-free in practice.
 * @param {string} relPath
 */
export function objectId (relPath) {
  if (relPath === '') return ROOT_ID
  const normalized = relPath.split(sep).join('/').normalize('NFC')
  return createHash('sha1').update(normalized).digest('base64url').slice(0, 16)
}

export const ID_PATTERN = /^(?:0|[A-Za-z0-9_-]{16})$/
