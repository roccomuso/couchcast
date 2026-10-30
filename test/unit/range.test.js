import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RangeNotSatisfiableError } from '../../src/errors.js'
import { parseRange } from '../../src/stream/range.js'

describe('parseRange', () => {
  const size = 1000

  it('no header → null', () => {
    assert.equal(parseRange(undefined, size), null)
    assert.equal(parseRange('', size), null)
  })

  it('closed, open and suffix ranges', () => {
    assert.deepEqual(parseRange('bytes=0-99', size), { start: 0, end: 99 })
    assert.deepEqual(parseRange('bytes=500-', size), { start: 500, end: 999 })
    assert.deepEqual(parseRange('bytes=-100', size), { start: 900, end: 999 })
    assert.deepEqual(parseRange('bytes=0-0', size), { start: 0, end: 0 })
  })

  it('clamps end and oversize suffix to the file', () => {
    assert.deepEqual(parseRange('bytes=900-5000', size), { start: 900, end: 999 })
    assert.deepEqual(parseRange('bytes=-5000', size), { start: 0, end: 999 })
  })

  it('tolerates whitespace and case; takes the first of multiple ranges', () => {
    assert.deepEqual(parseRange('Bytes = 10 - 20', size), { start: 10, end: 20 })
    assert.deepEqual(parseRange('bytes=0-9,20-29', size), { start: 0, end: 9 })
  })

  it('ignores syntactically invalid headers (serve full file)', () => {
    assert.equal(parseRange('bytes=abc', size), null)
    assert.equal(parseRange('items=0-1', size), null)
    assert.equal(parseRange('bytes=-', size), null)
    assert.equal(parseRange('bytes=20-10', size), null)
    assert.equal(parseRange('bytes=99999999999999999999-', size), null)
  })

  it('unsatisfiable → RangeNotSatisfiableError', () => {
    assert.throws(() => parseRange('bytes=1000-', size), RangeNotSatisfiableError)
    assert.throws(() => parseRange('bytes=5000-6000', size), RangeNotSatisfiableError)
    assert.throws(() => parseRange('bytes=-0', size), RangeNotSatisfiableError)
    assert.throws(() => parseRange('bytes=0-', 0), RangeNotSatisfiableError)
  })
})
