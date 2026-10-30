import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { silentLogger } from './logger.js'
import { which } from './util.js'

/**
 * @typedef {'disabled' | 'unsupported' | 'idle' | 'active' | 'grace'} KeepAwakeState
 * @typedef {{ command: string, args: string[] }} Inhibitor
 */

/**
 * Pick the platform's sleep inhibitor. Both variants exit on their own if we
 * die without cleaning up, so a crash can never leave the machine sleepless.
 * @param {{ platform?: NodeJS.Platform, pid?: number, find?: typeof which }} [opts]
 * @returns {Promise<Inhibitor | null>}
 */
export async function detectInhibitor ({ platform = process.platform, pid = process.pid, find = which } = {}) {
  if (platform === 'darwin') {
    const bin = await find('caffeinate')
    // -i: prevent idle sleep. -w: exit when our pid exits.
    return bin ? { command: bin, args: ['-i', '-w', String(pid)] } : null
  }
  if (platform === 'linux') {
    const bin = await find('systemd-inhibit')
    if (!bin) return null
    return {
      command: bin,
      args: [
        '--what=idle:sleep', '--who=couchcast', '--why=Streaming media over DLNA', '--mode=block',
        // Emulate caffeinate -w: hold the lock only while our pid is alive.
        'sh', '-c', 'while kill -0 "$0" 2>/dev/null; do sleep 5; done', String(pid),
      ],
    }
  }
  return null
}

/**
 * Reference-counted keep-awake. acquire() per active stream, release() when it
 * ends. The inhibitor starts on the first acquire and is stopped `graceMs`
 * after the last release (clients often pause or reconnect between ranges).
 * Emits 'change' with the new state.
 */
export class KeepAwake extends EventEmitter {
  /** @type {KeepAwakeState} */
  #state
  #refs = 0
  /** @type {import('node:child_process').ChildProcess | null} */
  #child = null
  /** @type {NodeJS.Timeout | undefined} */
  #grace
  #graceMs
  #inhibitor
  #spawn
  #log

  /**
   * @param {{
   *   inhibitor: Inhibitor | null,
   *   enabled?: boolean,
   *   graceMs?: number,
   *   spawn?: typeof nodeSpawn,
   *   logger?: import('./logger.js').Logger,
   * }} opts
   */
  constructor ({ inhibitor, enabled = true, graceMs = 120_000, spawn = nodeSpawn, logger = silentLogger }) {
    super()
    this.#inhibitor = inhibitor
    this.#graceMs = graceMs
    this.#spawn = spawn
    this.#log = logger.child('keep-awake')
    this.#state = !enabled ? 'disabled' : inhibitor ? 'idle' : 'unsupported'
  }

  #graceEndsAt = 0
  #disposed = false

  get state () { return this.#state }
  get graceMs () { return this.#graceMs }
  /** Epoch ms when the grace period ends (only meaningful in 'grace'). */
  get graceEndsAt () { return this.#graceEndsAt }
  get tool () { return this.#inhibitor?.command.split('/').pop() ?? null }

  acquire () {
    if (this.#disposed) return
    this.#refs++
    if (this.#state === 'disabled' || this.#state === 'unsupported') return
    clearTimeout(this.#grace)
    this.#grace = undefined
    if (!this.#child) this.#start()
    this.#set('active')
  }

  release () {
    if (this.#disposed || this.#refs === 0) return
    this.#refs--
    if (this.#refs > 0 || this.#state !== 'active') return
    this.#graceEndsAt = Date.now() + this.#graceMs
    this.#set('grace')
    this.#grace = setTimeout(() => {
      this.#grace = undefined
      this.#stop()
      this.#set('idle')
    }, this.#graceMs)
  }

  /** Stop the helper and ignore any later acquire/release (streams torn down on shutdown). */
  dispose () {
    this.#disposed = true
    clearTimeout(this.#grace)
    this.#grace = undefined
    this.#stop()
    this.removeAllListeners()
  }

  #start () {
    const inh = /** @type {Inhibitor} */ (this.#inhibitor)
    const child = this.#spawn(inh.command, inh.args, { stdio: 'ignore' })
    this.#child = child
    this.#log.info('preventing sleep (%s)', inh.command.split('/').pop())
    child.once('error', (err) => {
      this.#log.warn('keep-awake failed: %s', err.message)
      if (this.#child === child) this.#child = null
    })
    child.once('exit', (code, signal) => {
      if (this.#child !== child) return
      this.#child = null
      if (signal !== 'SIGTERM') this.#log.warn('keep-awake helper exited unexpectedly (code %s)', code ?? signal)
    })
  }

  #stop () {
    const child = this.#child
    if (!child) return
    this.#child = null
    child.kill('SIGTERM')
    this.#log.info('allowing sleep again')
  }

  /** @param {KeepAwakeState} s */
  #set (s) {
    if (s === this.#state) return
    this.#state = s
    this.emit('change', s)
  }
}
