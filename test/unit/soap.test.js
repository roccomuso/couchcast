import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { ErrorCode, UpnpError } from '../../src/errors.js'
import { parseSoapActionHeader, parseSoapRequest, soapFault, soapResponse } from '../../src/upnp/soap.js'

const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1'
const envelope = (inner) => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${inner}</s:Body>
</s:Envelope>`

describe('SOAPACTION header', () => {
  it('parses quoted and unquoted forms', () => {
    assert.deepEqual(parseSoapActionHeader(`"${CDS}#Browse"`), { serviceType: CDS, action: 'Browse' })
    assert.deepEqual(parseSoapActionHeader(`${CDS}#Browse`), { serviceType: CDS, action: 'Browse' })
    assert.equal(parseSoapActionHeader(undefined), null)
    assert.equal(parseSoapActionHeader('garbage'), null)
  })
})

describe('parseSoapRequest', () => {
  const body = envelope(`<u:Browse xmlns:u="${CDS}">
    <ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag>
    <Filter>dc:title,res@size</Filter><StartingIndex>0</StartingIndex>
    <RequestedCount>50</RequestedCount><SortCriteria>+dc:title</SortCriteria>
  </u:Browse>`)

  it('extracts args as strings', () => {
    const r = parseSoapRequest(body, `"${CDS}#Browse"`)
    assert.equal(r.action, 'Browse')
    assert.equal(r.serviceType, CDS)
    assert.deepEqual(r.args, {
      ObjectID: '0',
      BrowseFlag: 'BrowseDirectChildren',
      Filter: 'dc:title,res@size',
      StartingIndex: '0',
      RequestedCount: '50',
      SortCriteria: '+dc:title',
    })
  })

  it('falls back to the body when SOAPACTION is missing', () => {
    assert.equal(parseSoapRequest(body, undefined).action, 'Browse')
  })

  it('decodes entities and keeps empty args', () => {
    const r = parseSoapRequest(envelope(`<u:Browse xmlns:u="${CDS}"><ObjectID>a&amp;b</ObjectID><SortCriteria></SortCriteria><Filter/></u:Browse>`), undefined)
    assert.equal(r.args.ObjectID, 'a&b')
    assert.equal(r.args.SortCriteria, '')
    assert.equal(r.args.Filter, '')
  })

  it('action without args', () => {
    const r = parseSoapRequest(envelope(`<u:GetSystemUpdateID xmlns:u="${CDS}"/>`), `"${CDS}#GetSystemUpdateID"`)
    assert.deepEqual(r.args, {})
  })

  it('header/body mismatch → 401', () => {
    assert.throws(() => parseSoapRequest(body, `"${CDS}#Search"`), (err) => err instanceof UpnpError && err.upnpCode === 401)
  })

  it('malformed XML → SOAP_PARSE', () => {
    assert.throws(() => parseSoapRequest('<not xml', undefined), { code: ErrorCode.SOAP_PARSE })
    assert.throws(() => parseSoapRequest('<a/>', undefined), { code: ErrorCode.SOAP_PARSE })
  })
})

describe('soapResponse / soapFault', () => {
  const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false })

  it('escapes values exactly once and keeps argument order', () => {
    const xml = soapResponse(CDS, 'Browse', { Result: '<DIDL-Lite>&</DIDL-Lite>', NumberReturned: 1, TotalMatches: 3, UpdateID: 9 })
    assert.equal(XMLValidator.validate(xml), true)
    assert.match(xml, /<Result>&lt;DIDL-Lite&gt;&amp;&lt;\/DIDL-Lite&gt;<\/Result><NumberReturned>1<\/NumberReturned><TotalMatches>3/)
    const doc = parser.parse(xml)
    assert.equal(doc.Envelope.Body.BrowseResponse.Result, '<DIDL-Lite>&</DIDL-Lite>')
  })

  it('fault carries the UPnP error code', () => {
    const xml = soapFault(701, 'No such object')
    assert.equal(XMLValidator.validate(xml), true)
    const fault = parser.parse(xml).Envelope.Body.Fault
    assert.equal(fault.faultcode, 's:Client')
    assert.equal(fault.detail.UPnPError.errorCode, '701')
  })

  it('refuses invalid element names', () => {
    assert.throws(() => soapResponse(CDS, 'Bad Name', {}), TypeError)
  })
})
