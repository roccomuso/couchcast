import { UpnpError, UpnpErrorCode } from '../errors.js'
import { sourceProtocolInfo } from '../probe/mime.js'

/**
 * ConnectionManager:1 for a server without PrepareForConnection: only the
 * implicit connection "0" exists.
 * @returns {Record<string, import('./content-directory.js').ActionHandler>}
 */
export function createConnectionManager () {
  const source = sourceProtocolInfo()
  return {
    GetProtocolInfo: () => ({ Source: source, Sink: '' }),
    GetCurrentConnectionIDs: () => ({ ConnectionIDs: '0' }),
    GetCurrentConnectionInfo ({ ConnectionID }) {
      if (ConnectionID !== '0') throw new UpnpError(UpnpErrorCode.NO_SUCH_CONNECTION, 'Invalid connection reference')
      return {
        RcsID: -1,
        AVTransportID: -1,
        ProtocolInfo: '',
        PeerConnectionManager: '',
        PeerConnectionID: -1,
        Direction: 'Output',
        Status: 'OK',
      }
    },
  }
}

/** Initial evented state for GENA subscribers. */
export const connectionManagerState = () => ({
  SourceProtocolInfo: sourceProtocolInfo(),
  SinkProtocolInfo: '',
  CurrentConnectionIDs: '0',
})
