import { CouchcastError, ErrorCode } from '../errors.js'
import { KeepAwake, detectInhibitor } from '../keep-awake.js'
import { createLogger, createRingSink, streamSink } from '../logger.js'
import { CouchcastServer } from '../server.js'

/**
 * @typedef {{
 *   dir?: string, name?: string, port?: number, interface?: string,
 *   ui: boolean, keepAwake: boolean, graceSeconds: number,
 *   ffprobe: boolean, watch: boolean, verbose: boolean,
 * }} ServeOptions
 */

/**
 * Run the media server until SIGINT/SIGTERM or `q`.
 * @param {ServeOptions} opts
 * @returns {Promise<number>} exit code
 */
export async function serve (opts) {
  const ring = opts.ui ? createRingSink(1000) : null
  const logger = createLogger({
    sinks: [ring ? ring.sink : streamSink(process.stdout, { verbose: opts.verbose, color: Boolean(process.stdout.isTTY) })],
  })
  const log = logger.child('cli')

  const server = new CouchcastServer({
    dir: opts.dir,
    name: opts.name,
    port: opts.port,
    interface: opts.interface,
    ffprobe: opts.ffprobe,
    watch: opts.watch,
    logger,
  })
  const inhibitor = opts.keepAwake ? await detectInhibitor() : null
  if (opts.keepAwake && !inhibitor) {
    log.warn(process.platform === 'linux'
      ? 'systemd-inhibit not found: cannot keep the machine awake while streaming'
      : `keep-awake is not supported on ${process.platform}`)
  }
  const keepAwake = new KeepAwake({ inhibitor, enabled: opts.keepAwake, graceMs: opts.graceSeconds * 1000, logger })
  server.on('stream:start', () => keepAwake.acquire())
  server.on('stream:end', () => keepAwake.release())

  /** @type {import('ink').Instance | null} */
  let ui = null
  /** @type {(code: number) => void} */
  let finish = () => {}
  const done = new Promise((resolve) => { finish = resolve })
  let stopping = false

  /** @param {number} code */
  const shutdown = async (code) => {
    if (stopping) {
      // Second Ctrl+C: the user means it.
      process.exit(code || 130)
    }
    stopping = true
    // Safety net: never hang on exit because a peer won't let go.
    const force = setTimeout(() => process.exit(code), 5000)
    force.unref()
    if (ui) {
      ui.unmount()
      await ui.waitUntilExit().catch(() => {})
      ui = null
    } else {
      log.info('shutting down')
    }
    await server.stop().catch((err) => log.error('shutdown: %s', err.message))
    keepAwake.dispose()
    clearTimeout(force)
    finish(code)
  }
  const onSignal = () => { shutdown(0) }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await server.start()
  } catch (err) {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    keepAwake.dispose()
    await server.stop().catch(() => {})
    if (ring) {
      // Startup failed before the UI took over the screen: surface the logs.
      const sink = streamSink(process.stderr, { verbose: opts.verbose })
      for (const e of ring.entries()) sink(e)
    }
    throw err
  }

  if (ring) {
    const { renderUi } = await import('../ui/index.js')
    ui = renderUi({
      server,
      keepAwake,
      ring,
      initialVerbose: opts.verbose,
      onQuit: () => { shutdown(0) },
      onRescan: () => { server.rescan().catch((err) => log.warn('rescan failed: %s', err.message)) },
    })
  }

  const code = await done
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  if (ring) {
    const s = server.snapshot()
    process.stdout.write(`couchcast stopped. Served ${s.videoCount} videos from ${s.dir}\n`)
  }
  return code
}

/**
 * @param {string | undefined} raw
 * @param {string} flag
 * @param {{ min: number, max: number }} bounds
 */
export function parseIntFlag (raw, flag, { min, max }) {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CouchcastError(ErrorCode.INVALID_ARG, `${flag} must be an integer between ${min} and ${max}`)
  }
  return n
}
