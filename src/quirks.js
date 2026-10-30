/**
 * Per-client tweaks, matched on request headers. Keep this table small and
 * evidence-based: every entry should point at a device that actually needed it.
 *
 * @typedef {{
 *   name: string,
 *   label: string,
 *   mimeAliases: Record<string, string>,
 *   subtitleRes: boolean,
 *   captionInfoEx: boolean,
 *   subtitleMime: string,
 * }} Quirks
 * @typedef {Partial<Quirks> & { name: string, label: string, match: RegExp }} QuirkRule
 */

/** @type {Quirks} */
export const DEFAULT_QUIRKS = Object.freeze({
  name: 'generic',
  label: '',
  mimeAliases: {},
  // Extra <res> carrying the .srt (LG, Sony, Philips, VLC pick it up).
  subtitleRes: true,
  // <sec:CaptionInfoEx> (Samsung). Harmless for everyone else.
  captionInfoEx: true,
  subtitleMime: 'text/srt',
})

/** @type {QuirkRule[]} first match wins */
export const RULES = [
  {
    name: 'samsung',
    label: 'Samsung TV',
    // e.g. "DLNADOC/1.50 SEC_HHP_[TV] Samsung Q7 Series/1.0" or X-AV-Client-Info: ...SEC_HHP...
    match: /SEC_HHP|Samsung|Tizen/i,
    // Older Samsung firmwares refuse video/x-matroska.
    mimeAliases: { 'video/x-matroska': 'video/x-mkv' },
  },
  {
    name: 'lg',
    label: 'LG TV',
    // e.g. "LGE_DLNA_SDK/1.6.0 [TV][webOS ...]" or "Linux/3.10 UPnP/1.0 LGE WebOS TV/..."
    match: /LGE|webOS|NetCast/i,
  },
  {
    name: 'sony',
    label: 'Sony TV',
    match: /BRAVIA|SonyDTV|Sony/i,
  },
  {
    name: 'philips',
    label: 'Philips TV',
    match: /Philips|PHILIPS-TV|NETTV/i,
  },
  {
    name: 'vlc',
    label: 'VLC',
    match: /VLC|LibVLC/i,
  },
  {
    name: 'kodi',
    label: 'Kodi',
    match: /Kodi|XBMC|Platinum/i,
  },
]

/**
 * @param {Record<string, string | string[] | undefined>} headers lower-cased request headers
 * @returns {Quirks}
 */
export function resolveQuirks (headers) {
  const hay = [headers['user-agent'], headers['x-av-client-info'], headers['friendlyname.dlna.org']]
    .flat().filter(Boolean).join(' ')
  const rule = RULES.find((r) => r.match.test(hay))
  if (!rule) return DEFAULT_QUIRKS
  const { match: _match, ...rest } = rule
  return { ...DEFAULT_QUIRKS, ...rest }
}

/**
 * Human-friendly client name for the UI.
 * @param {Record<string, string | string[] | undefined>} headers
 */
export function clientLabel (headers) {
  const friendly = headers['friendlyname.dlna.org']
  if (typeof friendly === 'string' && friendly) return friendly
  const q = resolveQuirks(headers)
  if (q.label) return q.label
  const ua = String(headers['user-agent'] ?? '')
  return ua.split(/[\s/]/)[0] || 'unknown'
}
