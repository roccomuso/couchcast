import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Per-user config directory. Override with COUCHCAST_CONFIG_DIR (tests, portable installs).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function configDir (env = process.env, platform = process.platform) {
  if (env.COUCHCAST_CONFIG_DIR) return env.COUCHCAST_CONFIG_DIR
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'couchcast')
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'couchcast')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'couchcast')
}

/**
 * @typedef {{ uuid: string }} PersistedState
 */

/**
 * Load the persisted state, creating a stable device UUID on first run so
 * clients keep seeing the same server across restarts.
 * @param {{ dir?: string }} [opts]
 * @returns {Promise<PersistedState>}
 */
export async function loadState ({ dir = configDir() } = {}) {
  const file = join(dir, 'state.json')
  /** @type {Partial<PersistedState>} */
  let state = {}
  try {
    state = JSON.parse(await readFile(file, 'utf8'))
  } catch {}
  if (typeof state.uuid === 'string' && /^[0-9a-f-]{36}$/i.test(state.uuid)) {
    return /** @type {PersistedState} */ (state)
  }
  const fresh = { ...state, uuid: randomUUID() }
  try {
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(fresh, null, 2) + '\n')
    await rename(tmp, file)
  } catch {
    // Read-only home: still run, just without a stable UUID.
  }
  return fresh
}
