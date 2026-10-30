import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/**
 * Resolve an executable on PATH without spawning `which`.
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string | null>}
 */
export async function which (bin, env = process.env) {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE').split(';') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {}
    }
  }
  return null
}

/**
 * Trailing-edge debounce with an explicit cancel for clean disposal.
 * @template {unknown[]} A
 * @param {(...args: A) => void} fn
 * @param {number} ms
 */
export function debounce (fn, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const debounced = (/** @type {A} */ ...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
  debounced.cancel = () => clearTimeout(timer)
  return debounced
}

/** @param {number} bytes */
export function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
