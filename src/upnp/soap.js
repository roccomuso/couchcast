import { XMLParser } from 'fast-xml-parser'
import { CouchcastError, ErrorCode, UpnpError, UpnpErrorCode } from '../errors.js'
import { raw, xml } from './xml.js'

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
})

/**
 * @typedef {{ serviceType: string, action: string, args: Record<string, string> }} SoapRequest
 */

/**
 * Parse `SOAPACTION: "urn:schemas-upnp-org:service:ContentDirectory:1#Browse"`.
 * @param {string | undefined} header
 * @returns {{ serviceType: string, action: string } | null}
 */
export function parseSoapActionHeader (header) {
  const m = /^\s*"?([^#"]+)#([^"\s]+)"?\s*$/.exec(header ?? '')
  return m ? { serviceType: m[1], action: m[2] } : null
}

/**
 * @param {string} body raw request XML
 * @param {string | undefined} soapActionHeader
 * @returns {SoapRequest}
 */
export function parseSoapRequest (body, soapActionHeader) {
  /** @type {any} */
  let doc
  try {
    doc = parser.parse(body, true)
  } catch (err) {
    throw new CouchcastError(ErrorCode.SOAP_PARSE, 'Malformed SOAP envelope', { cause: err })
  }
  const soapBody = doc?.Envelope?.Body
  if (!soapBody || typeof soapBody !== 'object') {
    throw new CouchcastError(ErrorCode.SOAP_PARSE, 'Missing SOAP Body')
  }
  const fromHeader = parseSoapActionHeader(soapActionHeader)
  // Some clients send a bare or missing SOAPACTION: fall back to the body.
  const action = fromHeader?.action ?? Object.keys(soapBody)[0]
  const node = soapBody[action]
  if (node === undefined) throw new UpnpError(UpnpErrorCode.INVALID_ACTION, 'Invalid Action')
  /** @type {Record<string, string>} */
  const args = {}
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) args[k] = typeof v === 'object' ? '' : String(v)
  }
  return { serviceType: fromHeader?.serviceType ?? '', action, args }
}

const ENVELOPE_OPEN = '<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
const ENVELOPE_CLOSE = '</s:Body></s:Envelope>\n'

/**
 * Build an action response. Values are escaped, so a DIDL-Lite `Result` ends
 * up entity-encoded inside the envelope, exactly as UPnP AV expects.
 * @param {string} serviceType
 * @param {string} action
 * @param {Record<string, string | number>} out ordered output arguments
 */
export function soapResponse (serviceType, action, out) {
  const args = Object.entries(out).map(([k, v]) => xml`<${rawName(k)}>${v}</${rawName(k)}>`)
  return ENVELOPE_OPEN + xml`<u:${rawName(action)}Response xmlns:u="${serviceType}">${args}</u:${rawName(action)}Response>`.value + ENVELOPE_CLOSE
}

/**
 * @param {number} code UPnP error code
 * @param {string} description
 */
export function soapFault (code, description) {
  return ENVELOPE_OPEN + xml`<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault>`.value + ENVELOPE_CLOSE
}

/**
 * Element names come from our own action tables, never from clients.
 * @param {string} name
 */
function rawName (name) {
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new TypeError(`Invalid XML name: ${name}`)
  return raw(name)
}
