import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Create a temp media tree. Keys are relative paths, values are file contents
 * (string/Buffer) or a byte count for deterministic filler.
 * @param {Record<string, string | Buffer | number>} files
 */
export async function mediaTree (files) {
  const root = await mkdtemp(join(tmpdir(), 'couchcast-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, typeof content === 'number' ? pattern(content) : content)
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Deterministic bytes: byte i = i % 251 (prime, so ranges are easy to verify). */
export function pattern (size) {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = i % 251
  return buf
}
