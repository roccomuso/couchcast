import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  matchSearch, mSearch, notifyAlive, notifyByebye, parseMessage, searchResponse, targets,
} from '../../src/ssdp/messages.js'

const UDN = 'uuid:11111111-2222-3333-4444-555555555555'
const DEVICE = 'urn:schemas-upnp-org:device:MediaServer:1'
const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1'
const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1'
const all = targets({ udn: UDN, deviceType: DEVICE, serviceTypes: [CDS, CMS] })
const info = { location: 'http://10.0.0.2:8200/description.xml', server: 'X/1 UPnP/1.0 couchcast/0', maxAge: 1800, bootId: 7, configId: 42 }

describe('ssdp targets', () => {
  it('advertises rootdevice, UDN, device type and every service', () => {
    assert.deepEqual(all, [
      { nt: 'upnp:rootdevice', usn: `${UDN}::upnp:rootdevice` },
      { nt: UDN, usn: UDN },
      { nt: DEVICE, usn: `${UDN}::${DEVICE}` },
      { nt: CDS, usn: `${UDN}::${CDS}` },
      { nt: CMS, usn: `${UDN}::${CMS}` },
    ])
  })
})

describe('matchSearch', () => {
  it('ssdp:all answers every target', () => {
    assert.equal(matchSearch('ssdp:all', all).length, 5)
  })
  it('exact type match', () => {
    assert.deepEqual(matchSearch(DEVICE, all), [{ st: DEVICE, usn: `${UDN}::${DEVICE}` }])
    assert.deepEqual(matchSearch(UDN, all), [{ st: UDN, usn: UDN }])
  })
  it('answers searches for older versions with the requested ST', () => {
    const newer = targets({ udn: UDN, deviceType: 'urn:schemas-upnp-org:device:MediaServer:2', serviceTypes: [] })
    assert.deepEqual(matchSearch(DEVICE, newer), [{ st: DEVICE, usn: `${UDN}::${DEVICE}` }])
  })
  it('ignores newer versions and unrelated types', () => {
    assert.deepEqual(matchSearch('urn:schemas-upnp-org:device:MediaServer:2', all), [])
    assert.deepEqual(matchSearch('urn:schemas-upnp-org:device:MediaRenderer:1', all), [])
    assert.deepEqual(matchSearch('urn:dial-multiscreen-org:service:dial:1', all), [])
  })
})

describe('message builders', () => {
  it('ssdp:alive', () => {
    const msg = parseMessage(notifyAlive(all[0], info))
    assert.equal(msg?.kind, 'request')
    assert.equal(msg.kind === 'request' && msg.method, 'NOTIFY')
    assert.deepEqual(msg.headers, {
      host: '239.255.255.250:1900',
      'cache-control': 'max-age=1800',
      location: info.location,
      nt: 'upnp:rootdevice',
      nts: 'ssdp:alive',
      server: info.server,
      usn: `${UDN}::upnp:rootdevice`,
      'bootid.upnp.org': '7',
      'configid.upnp.org': '42',
    })
  })

  it('ssdp:byebye has no LOCATION or CACHE-CONTROL', () => {
    const msg = parseMessage(notifyByebye(all[3], info))
    assert.equal(msg?.headers.nts, 'ssdp:byebye')
    assert.equal(msg?.headers.usn, `${UDN}::${CDS}`)
    assert.equal(msg?.headers.location, undefined)
    assert.equal(msg?.headers['cache-control'], undefined)
  })

  it('search response', () => {
    const date = new Date('2026-01-02T03:04:05Z')
    const buf = searchResponse({ st: CDS, usn: `${UDN}::${CDS}` }, { ...info, date })
    const text = buf.toString()
    assert.match(text, /^HTTP\/1\.1 200 OK\r\n/)
    assert.match(text, /\r\nEXT: \r\n/)
    assert.ok(text.endsWith('\r\n\r\n'))
    const msg = parseMessage(buf)
    assert.equal(msg?.kind === 'response' && msg.status, 200)
    assert.equal(msg?.headers.st, CDS)
    assert.equal(msg?.headers.date, 'Fri, 02 Jan 2026 03:04:05 GMT')
    assert.equal(msg?.headers.location, info.location)
  })

  it('M-SEARCH round-trips', () => {
    const msg = parseMessage(mSearch('ssdp:all', { mx: 3 }))
    assert.equal(msg?.kind === 'request' && msg.method, 'M-SEARCH')
    assert.equal(msg?.headers.man, '"ssdp:discover"')
    assert.equal(msg?.headers.mx, '3')
  })
})

describe('parseMessage', () => {
  it('tolerates bare LF and odd casing', () => {
    const msg = parseMessage('M-SEARCH * HTTP/1.1\nHost: 239.255.255.250:1900\nSt: ssdp:all\nMan: "ssdp:discover"\n\n')
    assert.equal(msg?.headers.st, 'ssdp:all')
  })
  it('rejects junk', () => {
    assert.equal(parseMessage('hello world'), null)
    assert.equal(parseMessage(''), null)
  })
})
