import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { XMLParser } from 'fast-xml-parser'
import { UpnpError } from '../../src/errors.js'
import { Library, ROOT_ID } from '../../src/library/index.js'
import { DEFAULT_QUIRKS } from '../../src/quirks.js'
import { createContentDirectory, parseSortCriteria } from '../../src/upnp/content-directory.js'
import { mediaTree } from '../helpers/fixtures.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (n) => n === 'item' || n === 'container' })
const ctx = { quirks: DEFAULT_QUIRKS, baseUrl: 'http://h:1' }
/** @param {number} code */
const upnp = (code) => (/** @type {unknown} */ err) => err instanceof UpnpError && err.upnpCode === code

describe('ContentDirectory', () => {
  /** @type {Awaited<ReturnType<typeof mediaTree>>} */
  let tree
  /** @type {Library} */
  let lib
  /** @type {ReturnType<typeof createContentDirectory>} */
  let cds

  before(async () => {
    tree = await mediaTree({ 'a.mp4': 30, 'b.mp4': 10, 'c.mp4': 20, 'd.mp4': 40, 'Folder/x.mp4': 1 })
    lib = new Library({ root: tree.root, title: 'Root' })
    await lib.scan()
    cds = createContentDirectory({ library: lib, getUpdateId: () => 77 })
  })
  after(async () => { lib.stop(); await tree.cleanup() })

  /** @param {Record<string, string>} args */
  const browse = (args) => {
    const out = cds.Browse({ BrowseFlag: 'BrowseDirectChildren', Filter: '*', ...args }, ctx)
    const didl = parser.parse(String(out.Result))['DIDL-Lite']
    return { out, titles: [...(didl.container ?? []), ...(didl.item ?? [])].map((n) => n['dc:title']) }
  }

  it('BrowseDirectChildren on root', () => {
    const { out, titles } = browse({ ObjectID: ROOT_ID })
    assert.deepEqual(titles, ['Folder', 'a', 'b', 'c', 'd'])
    assert.equal(out.NumberReturned, 5)
    assert.equal(out.TotalMatches, 5)
    assert.equal(out.UpdateID, 77)
  })

  it('paging with StartingIndex/RequestedCount', () => {
    const { out, titles } = browse({ ObjectID: ROOT_ID, StartingIndex: '1', RequestedCount: '2' })
    assert.deepEqual(titles, ['a', 'b'])
    assert.equal(out.NumberReturned, 2)
    assert.equal(out.TotalMatches, 5)
    assert.equal(browse({ ObjectID: ROOT_ID, StartingIndex: '10' }).out.NumberReturned, 0)
  })

  it('SortCriteria', () => {
    assert.deepEqual(browse({ ObjectID: ROOT_ID, SortCriteria: '-dc:title' }).titles, ['Folder', 'd', 'c', 'b', 'a'])
    assert.deepEqual(browse({ ObjectID: ROOT_ID, SortCriteria: '+upnp:class,+res@size' }).titles, ['Folder', 'b', 'c', 'a', 'd'])
  })

  it('BrowseMetadata on root and on an item', () => {
    const root = cds.Browse({ ObjectID: ROOT_ID, BrowseFlag: 'BrowseMetadata' }, ctx)
    assert.equal(root.NumberReturned, 1)
    const didl = parser.parse(String(root.Result))['DIDL-Lite']
    assert.equal(didl.container[0]['@id'], '0')
    assert.equal(didl.container[0]['@parentID'], '-1')
    assert.equal(didl.container[0]['@childCount'], '5')

    const a = lib.children(ROOT_ID).find((n) => n.title === 'a')
    const meta = cds.Browse({ ObjectID: String(a?.id), BrowseFlag: 'BrowseMetadata' }, ctx)
    assert.equal(parser.parse(String(meta.Result))['DIDL-Lite'].item[0]['dc:title'], 'a')
  })

  it('errors', () => {
    assert.throws(() => cds.Browse({ ObjectID: 'missing', BrowseFlag: 'BrowseMetadata' }, ctx), upnp(701))
    const a = lib.children(ROOT_ID).find((n) => n.title === 'a')
    assert.throws(() => cds.Browse({ ObjectID: String(a?.id), BrowseFlag: 'BrowseDirectChildren' }, ctx), upnp(710))
    assert.throws(() => cds.Browse({ ObjectID: ROOT_ID, BrowseFlag: 'Nope' }, ctx), upnp(402))
    assert.throws(() => cds.Browse({ ObjectID: ROOT_ID, BrowseFlag: 'BrowseDirectChildren', StartingIndex: '-1' }, ctx), upnp(402))
    assert.throws(() => cds.Browse({ BrowseFlag: 'BrowseMetadata' }, ctx), upnp(402))
    assert.throws(() => browse({ ObjectID: ROOT_ID, SortCriteria: '+upnp:artist' }), upnp(709))
  })

  it('capabilities and update ID', () => {
    assert.deepEqual(cds.GetSystemUpdateID({}, ctx), { Id: 77 })
    assert.deepEqual(cds.GetSearchCapabilities({}, ctx), { SearchCaps: '' })
    assert.match(String(cds.GetSortCapabilities({}, ctx).SortCaps), /dc:title/)
    assert.match(String(cds.X_GetFeatureList({}, ctx).FeatureList), /samsung\.com_BASICVIEW/)
  })

  it('parseSortCriteria', () => {
    assert.deepEqual(parseSortCriteria(' +dc:title , -dc:date '), [{ key: 'dc:title', desc: false }, { key: 'dc:date', desc: true }])
    assert.deepEqual(parseSortCriteria(''), [])
  })
})
