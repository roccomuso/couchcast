import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { XMLParser } from 'fast-xml-parser'
import { CouchcastServer } from '../../src/server.js'
import { mSearch, parseMessage } from '../../src/ssdp/messages.js'
import { mediaTree, pattern } from '../helpers/fixtures.js'

const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1'
const SIZE = 3 * 1024 * 1024 + 17
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: false, parseTagValue: false, isArray: (n) => n === 'item' || n === 'container' || n === 'res' })

/** Low-level GET/HEAD returning raw headers + body (fetch hides some DLNA headers' casing quirks). */
function request (url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.request(url, { method, headers, signal: AbortSignal.timeout(5000) }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject).end()
  })
}

describe('CouchcastServer (localhost)', () => {
  /** @type {Awaited<ReturnType<typeof mediaTree>>} */
  let tree
  /** @type {CouchcastServer} */
  let server
  let configDir = ''
  /** @type {any[]} */
  const streamEvents = []

  before(async () => {
    tree = await mediaTree({
      'Big Buck Bunny.mp4': SIZE,
      'Big Buck Bunny.srt': '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
      'Series/Ep 1.mkv': 1000,
      '.DS_Store': 'x',
    })
    configDir = await mkdtemp(join(tmpdir(), 'couchcast-cfg-'))
    server = new CouchcastServer({
      dir: tree.root,
      name: 'Test & Co',
      interface: '127.0.0.1',
      port: 0,
      ssdpPort: 0,
      ffprobe: false,
      watch: false,
      configDir,
    })
    server.on('stream:start', (s) => streamEvents.push(['start', s.title]))
    server.on('stream:end', (s, reason) => streamEvents.push(['end', s.title, reason]))
    await server.start()
  })

  after(async () => {
    await server.stop()
    await tree.cleanup()
    await rm(configDir, { recursive: true, force: true })
  })

  /** @param {string} id @param {string} flag @param {Record<string,string>} [headers] */
  async function browse (id, flag = 'BrowseDirectChildren', headers = {}) {
    const res = await fetch(`${server.baseUrl}/upnp/cds/control`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${CDS}#Browse"`, ...headers },
      body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Browse xmlns:u="${CDS}"><ObjectID>${id}</ObjectID><BrowseFlag>${flag}</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`,
    })
    const env = parser.parse(await res.text())
    return { status: res.status, body: env['s:Envelope']['s:Body'] }
  }

  it('answers a unicast M-SEARCH with LOCATION pointing to the description', async () => {
    const sock = dgram.createSocket('udp4')
    await new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve(undefined)))
    try {
      const reply = once(sock, 'message', { signal: AbortSignal.timeout(3000) })
      sock.send(mSearch('urn:schemas-upnp-org:device:MediaServer:1', { host: `127.0.0.1:${server.ssdpPort}` }), server.ssdpPort, '127.0.0.1')
      const [buf] = await reply
      const msg = parseMessage(buf)
      assert.equal(msg?.kind === 'response' && msg.status, 200)
      assert.equal(msg?.headers.st, 'urn:schemas-upnp-org:device:MediaServer:1')
      assert.equal(msg?.headers.location, `${server.baseUrl}/description.xml`)
      assert.match(msg?.headers.usn ?? '', /^uuid:[0-9a-f-]{36}::urn:schemas-upnp-org:device:MediaServer:1$/)
    } finally {
      sock.close()
    }
  })

  it('serves the device description and SCPDs', async () => {
    const res = await fetch(`${server.baseUrl}/description.xml`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/xml/)
    const xml = await res.text()
    assert.match(xml, /<friendlyName>Test &amp; Co<\/friendlyName>/)
    assert.match(xml, /<deviceType>urn:schemas-upnp-org:device:MediaServer:1<\/deviceType>/)
    assert.equal(server.snapshot().udn, xml.match(/<UDN>(.+?)<\/UDN>/)?.[1])
    const scpd = await fetch(`${server.baseUrl}/upnp/cds/scpd.xml`).then((r) => r.text())
    assert.match(scpd, /<name>Browse<\/name>/)
  })

  it('keeps the device UUID across restarts', async () => {
    const again = new CouchcastServer({ dir: tree.root, interface: '127.0.0.1', port: 0, ssdpPort: 0, ffprobe: false, watch: false, configDir })
    await again.start()
    try {
      assert.equal(again.snapshot().udn, server.snapshot().udn)
    } finally {
      await again.stop()
    }
  })

  /** @type {any} */
  let movie

  it('Browse root → folder + video with subtitle', async () => {
    const { status, body } = await browse('0')
    assert.equal(status, 200)
    const r = body['u:BrowseResponse']
    assert.equal(r.TotalMatches, '2')
    const didl = parser.parse(r.Result)['DIDL-Lite']
    assert.equal(didl.container[0]['dc:title'], 'Series')
    movie = didl.item[0]
    assert.equal(movie['dc:title'], 'Big Buck Bunny')
    assert.equal(movie.res[0]['@size'], String(SIZE))
    assert.match(movie.res[0]['@protocolInfo'], /^http-get:\*:video\/mp4:DLNA\.ORG_OP=01;/)
    assert.equal(movie.res[1]['@protocolInfo'], 'http-get:*:text/srt:*')
  })

  it('Browse errors come back as SOAP faults', async () => {
    const { status, body } = await browse('does-not-exist')
    assert.equal(status, 500)
    assert.equal(body['s:Fault'].detail.UPnPError.errorCode, '701')
  })

  it('ranged GET returns exactly the requested bytes', async () => {
    const url = movie.res[0]['#text']
    const start = 1_000_000
    const end = 1_065_535
    const res = /** @type {any} */ (await request(url, { headers: { Range: `bytes=${start}-${end}`, 'getcontentFeatures.dlna.org': '1' } }))
    assert.equal(res.status, 206)
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${SIZE}`)
    assert.equal(res.headers['content-length'], String(end - start + 1))
    assert.equal(res.headers['accept-ranges'], 'bytes')
    assert.equal(res.headers['transfermode.dlna.org'], 'Streaming')
    assert.match(res.headers['contentfeatures.dlna.org'], /^DLNA\.ORG_OP=01;DLNA\.ORG_CI=0;/)
    assert.ok(res.body.equals(pattern(SIZE).subarray(start, end + 1)))
  })

  it('full GET, HEAD, suffix range and 416', async () => {
    const url = movie.res[0]['#text']
    const full = /** @type {any} */ (await request(url))
    assert.equal(full.status, 200)
    assert.equal(full.body.length, SIZE)
    assert.equal(full.headers['contentfeatures.dlna.org'], undefined, 'only sent when asked')

    const head = /** @type {any} */ (await request(url, { method: 'HEAD' }))
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], String(SIZE))
    assert.equal(head.body.length, 0)

    const tail = /** @type {any} */ (await request(url, { headers: { Range: 'bytes=-10' } }))
    assert.equal(tail.status, 206)
    assert.ok(tail.body.equals(pattern(SIZE).subarray(SIZE - 10)))

    const bad = /** @type {any} */ (await request(url, { headers: { Range: `bytes=${SIZE}-` } }))
    assert.equal(bad.status, 416)
    assert.equal(bad.headers['content-range'], `bytes */${SIZE}`)
  })

  it('subtitles, incl. Samsung CaptionInfo.sec header', async () => {
    const url = movie.res[0]['#text']
    const samsung = /** @type {any} */ (await request(url, { method: 'HEAD', headers: { 'getCaptionInfo.sec': '1', 'User-Agent': 'SEC_HHP_[TV] Samsung' } }))
    assert.equal(samsung.headers['captioninfo.sec'], movie.res[1]['#text'])
    const srt = /** @type {any} */ (await request(movie.res[1]['#text']))
    assert.equal(srt.status, 200)
    assert.equal(srt.headers['content-type'], 'text/srt')
    assert.match(srt.body.toString(), /Hello/)
  })

  it('emits stream start/end events for media but not for subtitles', () => {
    assert.ok(streamEvents.some(([t, title]) => t === 'start' && title === 'Big Buck Bunny'))
    assert.ok(streamEvents.some(([t, , reason]) => t === 'end' && reason === 'complete'))
    assert.ok(!streamEvents.some(([, title]) => String(title).endsWith('.srt')))
    assert.equal(server.snapshot().streams.length, 0)
  })

  it('aborted client is cleaned up', async () => {
    const before = streamEvents.length
    await new Promise((resolve) => {
      const req = http.get(movie.res[0]['#text'], (res) => {
        res.once('data', () => { req.destroy(); resolve(undefined) })
      })
      req.on('error', () => {})
    })
    for (let i = 0; i < 100 && server.snapshot().streams.length > 0; i++) await setTimeout(10)
    assert.equal(server.snapshot().streams.length, 0)
    assert.ok(streamEvents.slice(before).some(([t, , reason]) => t === 'end' && reason === 'aborted'))
  })

  it('unknown paths 404', async () => {
    assert.equal((await fetch(`${server.baseUrl}/media/AAAAAAAAAAAAAAAA.mp4`)).status, 404)
    assert.equal((await fetch(`${server.baseUrl}/media/../../etc/passwd`)).status, 404)
    assert.equal((await fetch(`${server.baseUrl}/nope`)).status, 404)
  })
})
