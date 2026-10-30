import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Library, ROOT_ID, objectId } from '../../src/library/index.js'
import { mediaTree } from '../helpers/fixtures.js'

describe('Library', () => {
  /** @type {Awaited<ReturnType<typeof mediaTree>>} */
  let tree
  /** @type {Library} */
  let lib

  before(async () => {
    tree = await mediaTree({
      'Movie 10.mp4': 100,
      'Movie 9.MKV': 50,
      'movie 9.srt': '1\n00:00:01,000 --> 00:00:02,000\nhi\n',
      'notes.txt': 'x',
      '.hidden.mp4': 1,
      '.secret/inside.mp4': 1,
      'Shows/S01/E02.m4v': 10,
      'Shows/S01/E01.m4v': 10,
      'Empty/readme.md': 'nothing to see',
    })
    lib = new Library({ root: tree.root, title: 'Test' })
    await lib.scan()
  })
  after(async () => {
    lib.stop()
    await tree.cleanup()
  })

  it('counts only visible videos', () => {
    assert.equal(lib.videoCount, 4)
  })

  it('root container is "0" with parent "-1"', () => {
    const root = lib.get(ROOT_ID)
    assert.equal(root?.kind, 'container')
    assert.equal(root?.parentId, '-1')
    assert.equal(root?.title, 'Test')
  })

  it('folders first, natural sort, hidden and empty folders skipped', () => {
    assert.deepEqual(lib.children(ROOT_ID).map((n) => n.title), ['Shows', 'Movie 9', 'Movie 10'])
    const shows = lib.children(ROOT_ID)[0]
    const s01 = lib.children(shows.id)[0]
    assert.equal(s01.title, 'S01')
    assert.deepEqual(lib.children(s01.id).map((n) => n.title), ['E01', 'E02'])
  })

  it('object IDs are stable and derived from the relative path', () => {
    const movie = lib.children(ROOT_ID).find((n) => n.title === 'Movie 10')
    assert.equal(movie?.id, objectId('Movie 10.mp4'))
    assert.match(movie?.id ?? '', /^[A-Za-z0-9_-]{16}$/)
    assert.equal(objectId(join('Shows', 'S01', 'E01.m4v')), objectId('Shows/S01/E01.m4v'))
  })

  it('items carry size, extension and parent', () => {
    const m9 = lib.children(ROOT_ID).find((n) => n.title === 'Movie 9')
    assert.equal(m9?.kind, 'item')
    if (m9?.kind !== 'item') return
    assert.equal(m9.ext, 'mkv')
    assert.equal(m9.size, 50)
    assert.equal(m9.parentId, ROOT_ID)
    assert.equal(lib.media(m9).mime, 'video/x-matroska')
  })

  it('pairs sidecar .srt case-insensitively', () => {
    const m9 = lib.children(ROOT_ID).find((n) => n.title === 'Movie 9')
    const m10 = lib.children(ROOT_ID).find((n) => n.title === 'Movie 10')
    assert.ok(m9?.kind === 'item' && m9.subtitle?.path.endsWith('movie 9.srt'))
    assert.ok(m10?.kind === 'item' && m10.subtitle === null)
  })

  it('rescan reports changes and emits "change"', async () => {
    assert.equal(await lib.scan(), false)
    let emitted = 0
    lib.on('change', () => emitted++)
    await writeFile(join(tree.root, 'New.webm'), 'x')
    assert.equal(await lib.scan(), true)
    assert.equal(lib.videoCount, 5)
    await rm(join(tree.root, 'New.webm'))
    assert.equal(await lib.scan(), true)
    assert.equal(emitted, 2)
  })

  it('unknown IDs', () => {
    assert.equal(lib.get('nope'), undefined)
    assert.deepEqual(lib.children('nope'), [])
  })
})
