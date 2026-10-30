import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { didlLite, formatDuration, mediaUrl } from '../../src/upnp/didl.js'
import { escapeXml } from '../../src/upnp/xml.js'
import { DEFAULT_QUIRKS, resolveQuirks } from '../../src/quirks.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false })

/** @returns {import('../../src/library/scan.js').ItemNode} */
const item = (over = {}) => ({
  kind: 'item',
  id: 'AAAAAAAAAAAAAAAA',
  parentId: '0',
  title: 'Tom & Jerry <"Best"> \'Of\'',
  path: '/x/Tom.mkv',
  relPath: 'Tom.mkv',
  ext: 'mkv',
  size: 123456,
  mtimeMs: Date.UTC(2024, 0, 2, 3, 4, 5),
  subtitle: null,
  ...over,
})

const opts = (over = {}) => ({
  baseUrl: 'http://10.0.0.2:8200',
  childCount: () => 3,
  media: () => ({ mime: 'video/x-matroska', probed: false }),
  quirks: DEFAULT_QUIRKS,
  ...over,
})

describe('escapeXml', () => {
  it('escapes the five XML specials', () => {
    assert.equal(escapeXml('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;')
  })
  it('strips characters illegal in XML 1.0', () => {
    assert.equal(escapeXml('a\u0000b\u0007c\u001Fd\tE\n'), 'abcd\tE\n')
    assert.equal(escapeXml('x\uD800y'), 'xy') // lone surrogate
    assert.equal(escapeXml('🎬'), '🎬') // valid pair survives
  })
})

describe('formatDuration', () => {
  it('formats H:MM:SS.mmm', () => {
    assert.equal(formatDuration(0), '0:00:00.000')
    assert.equal(formatDuration(5025.5), '1:23:45.500')
    assert.equal(formatDuration(36000), '10:00:00.000')
  })
})

describe('didlLite', () => {
  it('produces valid XML with escaped titles', () => {
    const xml = didlLite([item()], opts())
    assert.equal(XMLValidator.validate(xml), true)
    const doc = parser.parse(xml)['DIDL-Lite']
    assert.match(xml, /<dc:title>Tom &amp; Jerry &lt;&quot;Best&quot;&gt; &apos;Of&apos;<\/dc:title>/)
    assert.equal(doc.item['dc:title'], 'Tom & Jerry <"Best"> \'Of\'')
    assert.equal(doc.item['upnp:class'], 'object.item.videoItem')
    assert.equal(doc.item['dc:date'], '2024-01-02T03:04:05')
    assert.equal(doc.item['@id'], 'AAAAAAAAAAAAAAAA')
    assert.equal(doc.item['@parentID'], '0')
    assert.equal(doc.item['@restricted'], '1')
  })

  it('emits res with DLNA protocolInfo, size and URL', () => {
    const doc = parser.parse(didlLite([item()], opts()))['DIDL-Lite']
    const res = doc.item.res
    assert.equal(res['#text'], 'http://10.0.0.2:8200/media/AAAAAAAAAAAAAAAA.mkv')
    assert.equal(res['@size'], '123456')
    assert.equal(res['@protocolInfo'], 'http-get:*:video/x-matroska:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000')
  })

  it('adds probed attributes (bitrate in bytes/s)', () => {
    const media = () => ({ mime: 'video/mp4', probed: true, duration: 61.25, width: 1920, height: 1080, bitrate: 8_000_000, audioChannels: 2, sampleRate: 48000 })
    const res = parser.parse(didlLite([item()], opts({ media })))['DIDL-Lite'].item.res
    assert.equal(res['@duration'], '0:01:01.250')
    assert.equal(res['@resolution'], '1920x1080')
    assert.equal(res['@bitrate'], '1000000')
    assert.equal(res['@nrAudioChannels'], '2')
  })

  it('applies quirks: Samsung gets video/x-mkv', () => {
    const quirks = resolveQuirks({ 'user-agent': 'DLNADOC/1.50 SEC_HHP_[TV] Samsung Q80/1.0' })
    const res = parser.parse(didlLite([item()], opts({ quirks })))['DIDL-Lite'].item.res
    assert.match(res['@protocolInfo'], /^http-get:\*:video\/x-mkv:/)
  })

  it('adds subtitle res and sec:CaptionInfoEx when a sidecar exists', () => {
    const it2 = item({ subtitle: { path: '/x/Tom.srt', size: 10, mtimeMs: 0 } })
    const xml = didlLite([it2], opts())
    assert.equal(XMLValidator.validate(xml), true)
    const doc = parser.parse(xml)['DIDL-Lite'].item
    assert.equal(doc.res.length, 2)
    assert.equal(doc.res[1]['@protocolInfo'], 'http-get:*:text/srt:*')
    assert.equal(doc.res[1]['#text'], 'http://10.0.0.2:8200/subs/AAAAAAAAAAAAAAAA.srt')
    assert.equal(doc['sec:CaptionInfoEx']['@sec:type'], 'srt')
    assert.match(xml, /xmlns:sec="http:\/\/www\.sec\.co\.kr\/"/)
  })

  it('renders containers with childCount', () => {
    const container = { kind: 'container', id: 'BBBBBBBBBBBBBBBB', parentId: '0', title: 'Shows', path: '/x/Shows', relPath: 'Shows', mtimeMs: 0, children: [] }
    const doc = parser.parse(didlLite([(container)], opts()))['DIDL-Lite']
    assert.equal(doc.container['@childCount'], '3')
    assert.equal(doc.container['upnp:class'], 'object.container.storageFolder')
  })

  it('mediaUrl keeps the extension (some TVs sniff it)', () => {
    assert.equal(mediaUrl(item({ ext: 'mp4' }), 'http://h:1'), 'http://h:1/media/AAAAAAAAAAAAAAAA.mp4')
  })
})
