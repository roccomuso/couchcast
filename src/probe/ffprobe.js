import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CouchcastError, ErrorCode } from '../errors.js'
import { which } from '../util.js'

const execFileP = promisify(execFile)

/**
 * @typedef {{
 *   container?: string, duration?: number, bitrate?: number,
 *   width?: number, height?: number, videoCodec?: string,
 *   audioCodec?: string, audioChannels?: number, sampleRate?: number,
 * }} ProbeSummary
 */

/**
 * Locate ffprobe: COUCHCAST_FFPROBE wins, then PATH.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function findFfprobe (env = process.env) {
  return env.COUCHCAST_FFPROBE || await which('ffprobe', env)
}

/**
 * @param {string} bin
 * @param {string} file
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<any>} raw ffprobe JSON
 */
export async function runFfprobe (bin, file, { signal, timeoutMs = 15_000 } = {}) {
  try {
    const { stdout } = await execFileP(bin, [
      '-v', 'error', '-hide_banner',
      '-print_format', 'json', '-show_format', '-show_streams',
      '--', file,
    ], { signal, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    return JSON.parse(stdout)
  } catch (err) {
    throw new CouchcastError(ErrorCode.PROBE_FAILED, `ffprobe failed for ${file}`, { cause: err })
  }
}

/** @param {unknown} v */
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * @param {any} json ffprobe output
 * @returns {ProbeSummary}
 */
export function summarize (json) {
  const streams = Array.isArray(json?.streams) ? json.streams : []
  const video = streams.find((/** @type {any} */ s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((/** @type {any} */ s) => s.codec_type === 'audio')
  return {
    container: json?.format?.format_name,
    duration: num(json?.format?.duration) ?? num(video?.duration),
    bitrate: num(json?.format?.bit_rate),
    width: num(video?.width),
    height: num(video?.height),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    audioChannels: num(audio?.channels),
    sampleRate: num(audio?.sample_rate),
  }
}
