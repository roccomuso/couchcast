import { xml } from './xml.js'

/**
 * @typedef {[name: string, type: string, opts?: { evented?: boolean, allowed?: string[] }]} StateVar
 * @typedef {[name: string, dir: 'in' | 'out', related: string]} Arg
 * @typedef {{ stateVariables: StateVar[], actions: Record<string, Arg[]> }} ServiceSpec
 */

/** @type {ServiceSpec} */
export const CONTENT_DIRECTORY = {
  stateVariables: [
    ['SystemUpdateID', 'ui4', { evented: true }],
    ['SearchCapabilities', 'string'],
    ['SortCapabilities', 'string'],
    ['A_ARG_TYPE_ObjectID', 'string'],
    ['A_ARG_TYPE_Result', 'string'],
    ['A_ARG_TYPE_BrowseFlag', 'string', { allowed: ['BrowseMetadata', 'BrowseDirectChildren'] }],
    ['A_ARG_TYPE_Filter', 'string'],
    ['A_ARG_TYPE_SortCriteria', 'string'],
    ['A_ARG_TYPE_Index', 'ui4'],
    ['A_ARG_TYPE_Count', 'ui4'],
    ['A_ARG_TYPE_UpdateID', 'ui4'],
    ['A_ARG_TYPE_Featurelist', 'string'],
  ],
  actions: {
    Browse: [
      ['ObjectID', 'in', 'A_ARG_TYPE_ObjectID'],
      ['BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag'],
      ['Filter', 'in', 'A_ARG_TYPE_Filter'],
      ['StartingIndex', 'in', 'A_ARG_TYPE_Index'],
      ['RequestedCount', 'in', 'A_ARG_TYPE_Count'],
      ['SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria'],
      ['Result', 'out', 'A_ARG_TYPE_Result'],
      ['NumberReturned', 'out', 'A_ARG_TYPE_Count'],
      ['TotalMatches', 'out', 'A_ARG_TYPE_Count'],
      ['UpdateID', 'out', 'A_ARG_TYPE_UpdateID'],
    ],
    GetSearchCapabilities: [['SearchCaps', 'out', 'SearchCapabilities']],
    GetSortCapabilities: [['SortCaps', 'out', 'SortCapabilities']],
    GetSystemUpdateID: [['Id', 'out', 'SystemUpdateID']],
    // Samsung extension: tells the TV which container holds videos.
    X_GetFeatureList: [['FeatureList', 'out', 'A_ARG_TYPE_Featurelist']],
  },
}

/** @type {ServiceSpec} */
export const CONNECTION_MANAGER = {
  stateVariables: [
    ['SourceProtocolInfo', 'string', { evented: true }],
    ['SinkProtocolInfo', 'string', { evented: true }],
    ['CurrentConnectionIDs', 'string', { evented: true }],
    ['A_ARG_TYPE_ConnectionStatus', 'string', { allowed: ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown'] }],
    ['A_ARG_TYPE_ConnectionManager', 'string'],
    ['A_ARG_TYPE_Direction', 'string', { allowed: ['Input', 'Output'] }],
    ['A_ARG_TYPE_ProtocolInfo', 'string'],
    ['A_ARG_TYPE_ConnectionID', 'i4'],
    ['A_ARG_TYPE_AVTransportID', 'i4'],
    ['A_ARG_TYPE_RcsID', 'i4'],
  ],
  actions: {
    GetProtocolInfo: [
      ['Source', 'out', 'SourceProtocolInfo'],
      ['Sink', 'out', 'SinkProtocolInfo'],
    ],
    GetCurrentConnectionIDs: [['ConnectionIDs', 'out', 'CurrentConnectionIDs']],
    GetCurrentConnectionInfo: [
      ['ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID'],
      ['RcsID', 'out', 'A_ARG_TYPE_RcsID'],
      ['AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID'],
      ['ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo'],
      ['PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager'],
      ['PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID'],
      ['Direction', 'out', 'A_ARG_TYPE_Direction'],
      ['Status', 'out', 'A_ARG_TYPE_ConnectionStatus'],
    ],
  },
}

/** @param {ServiceSpec} spec */
export function scpd (spec) {
  const actions = Object.entries(spec.actions).map(([name, args]) => xml`
    <action>
      <name>${name}</name>
      <argumentList>${args.map(([argName, dir, related]) => xml`
        <argument><name>${argName}</name><direction>${dir}</direction><relatedStateVariable>${related}</relatedStateVariable></argument>`)}
      </argumentList>
    </action>`)
  const vars = spec.stateVariables.map(([name, type, opts = {}]) => xml`
    <stateVariable sendEvents="${opts.evented ? 'yes' : 'no'}">
      <name>${name}</name>
      <dataType>${type}</dataType>${opts.allowed
        ? xml`
      <allowedValueList>${opts.allowed.map((v) => xml`<allowedValue>${v}</allowedValue>`)}</allowedValueList>`
        : ''}
    </stateVariable>`)
  return `<?xml version="1.0" encoding="utf-8"?>\n${xml`<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>${actions}
  </actionList>
  <serviceStateTable>${vars}
  </serviceStateTable>
</scpd>`}\n`
}

/** @param {ServiceSpec} spec */
export const eventedVariables = (spec) =>
  spec.stateVariables.filter(([, , o]) => o?.evented).map(([n]) => n)
