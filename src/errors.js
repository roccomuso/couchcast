/**
 * Error codes used across couchcast. Stable strings: safe to match on.
 */
export const ErrorCode = Object.freeze({
  NO_INTERFACE: 'ERR_COUCHCAST_NO_INTERFACE',
  PORT_IN_USE: 'ERR_COUCHCAST_PORT_IN_USE',
  INVALID_ARG: 'ERR_COUCHCAST_INVALID_ARG',
  NOT_A_DIRECTORY: 'ERR_COUCHCAST_NOT_A_DIRECTORY',
  SOAP_PARSE: 'ERR_COUCHCAST_SOAP_PARSE',
  UPNP_ACTION: 'ERR_COUCHCAST_UPNP_ACTION',
  RANGE_NOT_SATISFIABLE: 'ERR_COUCHCAST_RANGE_NOT_SATISFIABLE',
  PROBE_FAILED: 'ERR_COUCHCAST_PROBE_FAILED',
  NOT_IMPLEMENTED: 'ERR_COUCHCAST_NOT_IMPLEMENTED',
})

export class CouchcastError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor (code, message, options) {
    super(message, options)
    this.name = 'CouchcastError'
    this.code = code
  }
}

/** UPnP action error, serialized as a SOAP fault with a numeric UPnPError code. */
export class UpnpError extends CouchcastError {
  /**
   * @param {number} upnpCode e.g. 701 (No such object)
   * @param {string} description
   */
  constructor (upnpCode, description) {
    super(ErrorCode.UPNP_ACTION, `UPnP error ${upnpCode}: ${description}`)
    this.name = 'UpnpError'
    this.upnpCode = upnpCode
    this.description = description
  }
}

export const UpnpErrorCode = Object.freeze({
  INVALID_ACTION: 401,
  INVALID_ARGS: 402,
  ACTION_FAILED: 501,
  NO_SUCH_OBJECT: 701,
  NO_SUCH_CONNECTION: 706,
  UNSUPPORTED_SORT: 709,
  NO_SUCH_CONTAINER: 710,
})

export class RangeNotSatisfiableError extends CouchcastError {
  /** @param {number} size */
  constructor (size) {
    super(ErrorCode.RANGE_NOT_SATISFIABLE, 'Range not satisfiable')
    this.name = 'RangeNotSatisfiableError'
    this.size = size
  }
}
