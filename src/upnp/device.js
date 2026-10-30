import { createHash } from 'node:crypto'
import { xml } from './xml.js'

export const DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaServer:1'

/**
 * @typedef {{ key: string, type: string, id: string }} ServiceDef
 */

/** @type {Record<'cds' | 'cms', ServiceDef>} */
export const SERVICES = {
  cds: {
    key: 'cds',
    type: 'urn:schemas-upnp-org:service:ContentDirectory:1',
    id: 'urn:upnp-org:serviceId:ContentDirectory',
  },
  cms: {
    key: 'cms',
    type: 'urn:schemas-upnp-org:service:ConnectionManager:1',
    id: 'urn:upnp-org:serviceId:ConnectionManager',
  },
}

/** @param {ServiceDef} s */
export const serviceUrls = (s) => ({
  scpd: `/upnp/${s.key}/scpd.xml`,
  control: `/upnp/${s.key}/control`,
  event: `/upnp/${s.key}/event`,
})

export const DESCRIPTION_PATH = '/description.xml'
export const PROJECT_URL = 'https://github.com/roccomuso/couchcast'

/**
 * @param {{ udn: string, friendlyName: string, version: string }} opts
 */
export function deviceDescription ({ udn, friendlyName, version }) {
  // Samsung TVs only ask for captions (getCaptionInfo.sec) when the server
  // advertises the capability here; other clients ignore unknown elements.
  const secCaps = 'smi,DCM10,getMediaInfo.sec,getCaptionInfo.sec'
  return `<?xml version="1.0" encoding="utf-8"?>\n${xml`<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0" xmlns:sec="http://www.sec.co.kr/dlna">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>${DEVICE_TYPE}</deviceType>
    <friendlyName>${friendlyName}</friendlyName>
    <manufacturer>couchcast</manufacturer>
    <manufacturerURL>${PROJECT_URL}</manufacturerURL>
    <modelDescription>couchcast DLNA media server</modelDescription>
    <modelName>couchcast</modelName>
    <modelNumber>${version}</modelNumber>
    <modelURL>${PROJECT_URL}</modelURL>
    <serialNumber>${udn.slice(5, 13)}</serialNumber>
    <UDN>${udn}</UDN>
    <dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>
    <sec:ProductCap>${secCaps}</sec:ProductCap>
    <sec:X_ProductCap>${secCaps}</sec:X_ProductCap>
    <serviceList>${Object.values(SERVICES).map((s) => {
      const u = serviceUrls(s)
      return xml`
      <service>
        <serviceType>${s.type}</serviceType>
        <serviceId>${s.id}</serviceId>
        <SCPDURL>${u.scpd}</SCPDURL>
        <controlURL>${u.control}</controlURL>
        <eventSubURL>${u.event}</eventSubURL>
      </service>`
    })}
    </serviceList>
  </device>
</root>`}\n`
}

/**
 * CONFIGID.UPNP.ORG must change whenever the description/SCPDs change.
 * Derived from the package version: stable within a release, 24-bit as per UDA 1.1.
 * @param {string} version
 */
export function configIdFor (version) {
  return createHash('sha1').update(`couchcast@${version}`).digest().readUIntBE(0, 3)
}
