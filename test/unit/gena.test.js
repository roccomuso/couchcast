import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { once } from 'node:events'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { Gena, parseCallbacks, parseTimeout, propertySet } from '../../src/upnp/gena.js'

describe('gena helpers', () => {
  it('parseCallbacks keeps http URLs only', () => {
    assert.deepEqual(parseCallbacks('<http://a:1/x><https://b/><nope><http://c:2/>').map(String), ['http://a:1/x', 'http://c:2/'])
  })
  it('parseTimeout clamps to [60, 1800]', () => {
    assert.equal(parseTimeout('Second-300'), 300)
    assert.equal(parseTimeout('Second-5'), 60)
    assert.equal(parseTimeout('Second-infinite'), 1800)
    assert.equal(parseTimeout(undefined), 1800)
  })
  it('propertySet escapes values', () => {
    assert.equal(propertySet({ A: '<&>' }), '<?xml version="1.0" encoding="utf-8"?>\n<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><A>&lt;&amp;&gt;</A></e:property></e:propertyset>\n')
  })
})

describe('Gena', () => {
  /** @type {http.Server} */ let sink
  /** @type {http.Server} */ let device
  /** @type {Array<{ headers: http.IncomingHttpHeaders, body: string }>} */
  const received = []
  let sinkUrl = ''
  let deviceUrl = ''
  let updateId = 1
  const gena = new Gena({ server: 'test', getState: () => ({ SystemUpdateID: updateId }) })

  before(async () => {
    sink = http.createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      received.push({ headers: req.headers, body })
      res.end()
    }).listen(0, '127.0.0.1')
    device = http.createServer((req, res) => gena.handle(req, res, 'cds')).listen(0, '127.0.0.1')
    await Promise.all([once(sink, 'listening'), once(device, 'listening')])
    sinkUrl = `http://127.0.0.1:${/** @type {any} */ (sink.address()).port}/cb`
    deviceUrl = `http://127.0.0.1:${/** @type {any} */ (device.address()).port}/event`
  })
  after(() => {
    gena.stop()
    sink.close()
    device.close()
  })

  /** @param {string} method @param {Record<string, string>} headers */
  const req = (method, headers) => new Promise((resolve, reject) => {
    http.request(deviceUrl, { method, headers }, (res) => { res.resume(); resolve(res) }).on('error', reject).end()
  })
  const waitFor = async (/** @type {number} */ n) => {
    for (let i = 0; i < 100 && received.length < n; i++) await setTimeout(10)
    assert.equal(received.length, n)
  }

  it('subscribe → initial event SEQ 0, then notify SEQ 1, renew, unsubscribe', async () => {
    const res = /** @type {http.IncomingMessage} */ (await req('SUBSCRIBE', { CALLBACK: `<${sinkUrl}>`, NT: 'upnp:event', TIMEOUT: 'Second-300' }))
    assert.equal(res.statusCode, 200)
    const sid = String(res.headers.sid)
    assert.match(sid, /^uuid:[0-9a-f-]{36}$/)
    assert.equal(res.headers.timeout, 'Second-300')

    await waitFor(1)
    assert.equal(received[0].headers.sid, sid)
    assert.equal(received[0].headers.seq, '0')
    assert.equal(received[0].headers.nt, 'upnp:event')
    assert.match(received[0].body, /<SystemUpdateID>1<\/SystemUpdateID>/)

    updateId = 2
    gena.notify('cds', { SystemUpdateID: updateId })
    gena.notify('cms', { Other: 1 }) // different service: not delivered
    await waitFor(2)
    assert.equal(received[1].headers.seq, '1')
    assert.match(received[1].body, /<SystemUpdateID>2</)

    const renew = /** @type {http.IncomingMessage} */ (await req('SUBSCRIBE', { SID: sid, TIMEOUT: 'Second-600' }))
    assert.equal(renew.statusCode, 200)
    assert.equal(renew.headers.timeout, 'Second-600')

    const bad = /** @type {http.IncomingMessage} */ (await req('SUBSCRIBE', { SID: sid, NT: 'upnp:event' }))
    assert.equal(bad.statusCode, 400)

    const unsub = /** @type {http.IncomingMessage} */ (await req('UNSUBSCRIBE', { SID: sid }))
    assert.equal(unsub.statusCode, 200)
    assert.equal(gena.size, 0)
    const again = /** @type {http.IncomingMessage} */ (await req('UNSUBSCRIBE', { SID: sid }))
    assert.equal(again.statusCode, 412)
  })

  it('rejects subscriptions without callback or NT', async () => {
    assert.equal((/** @type {any} */ (await req('SUBSCRIBE', { NT: 'upnp:event' }))).statusCode, 412)
    assert.equal((/** @type {any} */ (await req('SUBSCRIBE', { CALLBACK: `<${sinkUrl}>` }))).statusCode, 412)
    assert.equal((/** @type {any} */ (await req('SUBSCRIBE', { SID: 'uuid:unknown' }))).statusCode, 412)
  })
})
