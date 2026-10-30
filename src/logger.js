import { EventEmitter } from 'node:events'
import { format } from 'node:util'

/**
 * @typedef {'debug'|'info'|'warn'|'error'} Level
 * @typedef {{ time: number, level: Level, scope: string, msg: string }} LogEntry
 * @typedef {(entry: LogEntry) => void} Sink
 * @typedef {{
 *   debug: (...args: unknown[]) => void,
 *   info: (...args: unknown[]) => void,
 *   warn: (...args: unknown[]) => void,
 *   error: (...args: unknown[]) => void,
 *   child: (scope: string) => Logger,
 * }} Logger
 */

export const LEVELS = /** @type {const} */ (['debug', 'info', 'warn', 'error'])

/**
 * Logger fanning out to pluggable sinks. Sinks decide what to show; the
 * logger itself never filters, so the UI can toggle verbosity after the fact.
 * @param {{ sinks?: Sink[], scope?: string }} [opts]
 * @returns {Logger & { addSink: (s: Sink) => () => void }}
 */
export function createLogger ({ sinks = [], scope = '' } = {}) {
  const all = new Set(sinks)
  /** @param {string} s @returns {Logger} */
  const make = (s) => {
    /** @param {Level} level */
    const emit = (level) => (/** @type {unknown[]} */ ...args) => {
      const entry = { time: Date.now(), level, scope: s, msg: format(...args) }
      for (const sink of all) {
        try { sink(entry) } catch { /* a broken sink must never break the app */ }
      }
    }
    return {
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
      child: (sub) => make(s ? `${s}:${sub}` : sub),
    }
  }
  return Object.assign(make(scope), {
    /** @param {Sink} sink */
    addSink (sink) {
      all.add(sink)
      return () => { all.delete(sink) }
    },
  })
}

/** A logger that drops everything; handy default for library code and tests. */
export const silentLogger = createLogger()

/**
 * Line-oriented sink for --no-ui / piping.
 * @param {NodeJS.WritableStream} stream
 * @param {{ verbose?: boolean, color?: boolean }} [opts]
 * @returns {Sink}
 */
export function streamSink (stream, { verbose = false, color = false } = {}) {
  const colors = { debug: '\x1b[90m', info: '', warn: '\x1b[33m', error: '\x1b[31m' }
  return (e) => {
    if (e.level === 'debug' && !verbose) return
    const ts = new Date(e.time).toISOString()
    const line = `${ts} ${e.level.toUpperCase().padEnd(5)} ${e.scope ? `[${e.scope}] ` : ''}${e.msg}`
    stream.write(color && colors[e.level] ? `${colors[e.level]}${line}\x1b[0m\n` : `${line}\n`)
  }
}

/**
 * Bounded in-memory sink; the Ink log pane renders from it.
 * Emits 'entry' for every new log line.
 * @param {number} [size]
 */
export function createRingSink (size = 500) {
  /** @type {LogEntry[]} */
  const entries = []
  const events = new EventEmitter()
  /** @type {Sink} */
  const sink = (e) => {
    entries.push(e)
    if (entries.length > size) entries.shift()
    events.emit('entry', e)
  }
  return { sink, entries: () => entries, events }
}
