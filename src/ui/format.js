import { formatBytes } from '../util.js'

export { formatBytes }

/** @param {number} bytesPerSec */
export const formatRate = (bytesPerSec) => `${formatBytes(bytesPerSec)}/s`

/** @param {number} ms */
export function formatAgo (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

/** @param {number} ms */
export function formatCountdown (ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * @param {number} fraction 0..1
 * @param {number} width
 */
export function bar (fraction, width) {
  const f = Math.min(1, Math.max(0, fraction))
  const full = Math.round(f * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

/**
 * @param {string} s
 * @param {number} max
 */
export function truncate (s, max) {
  if (max <= 1) return s.slice(0, Math.max(0, max))
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** @param {string} p */
export function tildify (p) {
  const home = process.env.HOME
  return home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p
}
