// Chars not allowed in XML 1.0 (C0 controls except TAB/LF/CR, lone surrogates, U+FFFE/U+FFFF).
// eslint-disable-next-line no-control-regex
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const ENTITIES = /** @type {Record<string, string>} */ ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})

/**
 * Strict XML escaping for both text nodes and attribute values. Strips
 * characters that are illegal in XML 1.0 (file names can contain them, and a
 * single bad byte makes most TVs reject the whole Browse response).
 * @param {unknown} value
 */
export function escapeXml (value) {
  return String(value ?? '').replace(INVALID, '').replace(/[&<>"']/g, (c) => ENTITIES[c])
}

/**
 * Tagged template that escapes every interpolation. Use `raw()` to opt out.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 */
export function xml (strings, ...values) {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    out += (v instanceof Raw ? v.value : Array.isArray(v) ? v.map((x) => x instanceof Raw ? x.value : escapeXml(x)).join('') : escapeXml(v)) + strings[i + 1]
  }
  return new Raw(out)
}

export class Raw {
  /** @param {string} value */
  constructor (value) { this.value = value }
  toString () { return this.value }
}

/** @param {string} value */
export const raw = (value) => new Raw(value)
