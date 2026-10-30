import { watch } from 'node:fs'
import { sep } from 'node:path'
import { silentLogger } from '../logger.js'
import { debounce } from '../util.js'

/**
 * Recursive, debounced directory watcher. Changes under hidden paths are ignored.
 * @param {string} root
 * @param {() => void} onChange
 * @param {{ debounceMs?: number, logger?: import('../logger.js').Logger }} [opts]
 * @returns {{ close: () => void }}
 */
export function watchTree (root, onChange, { debounceMs = 1500, logger = silentLogger } = {}) {
  const fire = debounce(onChange, debounceMs)
  /** @type {import('node:fs').FSWatcher | null} */
  let watcher = null
  const close = () => {
    fire.cancel()
    watcher?.close()
    watcher = null
  }
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && String(filename).split(sep).some((p) => p.startsWith('.'))) return
      fire()
    })
    watcher.on('error', (err) => {
      logger.warn('file watcher stopped: %s (press r to rescan manually)', err.message)
      close()
    })
  } catch (err) {
    logger.warn('cannot watch %s: %s', root, /** @type {Error} */ (err).message)
  }
  return { close }
}
