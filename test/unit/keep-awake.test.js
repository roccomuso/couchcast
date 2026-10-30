import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, it, mock } from 'node:test'
import { KeepAwake, detectInhibitor } from '../../src/keep-awake.js'

function fakeSpawn () {
  /** @type {Array<EventEmitter & { args: string[], killed: string | null, kill: (s: string) => void }>} */
  const children = []
  const spawn = (/** @type {string} */ _cmd, /** @type {string[]} */ args) => {
    const child = Object.assign(new EventEmitter(), {
      args,
      killed: /** @type {string | null} */ (null),
      kill (/** @type {string} */ sig) { this.killed = sig; this.emit('exit', null, sig) },
    })
    children.push(child)
    return child
  }
  return { spawn: /** @type {any} */ (spawn), children }
}

describe('detectInhibitor', () => {
  it('macOS: caffeinate -i -w <pid>', async () => {
    const inh = await detectInhibitor({ platform: 'darwin', pid: 42, find: async () => '/usr/bin/caffeinate' })
    assert.deepEqual(inh, { command: '/usr/bin/caffeinate', args: ['-i', '-w', '42'] })
  })
  it('Linux: systemd-inhibit bound to our pid', async () => {
    const inh = await detectInhibitor({ platform: 'linux', pid: 42, find: async () => '/usr/bin/systemd-inhibit' })
    assert.equal(inh?.command, '/usr/bin/systemd-inhibit')
    assert.ok(inh?.args.includes('--what=idle:sleep'))
    assert.equal(inh?.args.at(-1), '42')
  })
  it('missing tool or other platform → null', async () => {
    assert.equal(await detectInhibitor({ platform: 'linux', find: async () => null }), null)
    assert.equal(await detectInhibitor({ platform: 'win32', find: async () => 'x' }), null)
  })
})

describe('KeepAwake', () => {
  beforeEach(() => mock.timers.reset())

  it('refcounts streams and waits for the grace period before releasing', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { spawn, children } = fakeSpawn()
    const ka = new KeepAwake({ inhibitor: { command: 'caffeinate', args: ['-i'] }, graceMs: 1000, spawn })
    const states = /** @type {string[]} */ ([])
    ka.on('change', (s) => states.push(s))

    assert.equal(ka.state, 'idle')
    ka.acquire()
    ka.acquire()
    assert.equal(children.length, 1, 'one helper for many streams')
    assert.equal(ka.state, 'active')
    ka.release()
    assert.equal(ka.state, 'active')
    ka.release()
    assert.equal(ka.state, 'grace')
    assert.equal(ka.graceEndsAt, Date.now() + 1000)

    mock.timers.tick(999)
    assert.equal(children[0].killed, null)
    ka.acquire() // a new stream during grace keeps the same helper
    assert.equal(ka.state, 'active')
    assert.equal(children.length, 1)
    ka.release()
    mock.timers.tick(1000)
    assert.equal(children[0].killed, 'SIGTERM')
    assert.equal(ka.state, 'idle')
    assert.deepEqual(states, ['active', 'grace', 'active', 'grace', 'idle'])

    ka.acquire()
    assert.equal(children.length, 2, 'respawns after going idle')
    ka.dispose()
    assert.equal(children[1].killed, 'SIGTERM')
    ka.release() // late stream:end during shutdown must not re-arm a timer
    ka.acquire()
    assert.equal(children.length, 2)
    assert.notEqual(ka.state, 'grace')
  })

  it('disabled / unsupported never spawn', () => {
    const { spawn, children } = fakeSpawn()
    const off = new KeepAwake({ inhibitor: { command: 'x', args: [] }, enabled: false, spawn })
    const none = new KeepAwake({ inhibitor: null, spawn })
    off.acquire(); none.acquire(); off.release(); none.release()
    assert.equal(children.length, 0)
    assert.equal(off.state, 'disabled')
    assert.equal(none.state, 'unsupported')
  })

  it('extra release() is a no-op', () => {
    const { spawn } = fakeSpawn()
    const ka = new KeepAwake({ inhibitor: { command: 'x', args: [] }, spawn })
    ka.release()
    assert.equal(ka.state, 'idle')
    ka.dispose()
  })
})
