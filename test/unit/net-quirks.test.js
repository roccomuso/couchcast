import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ErrorCode } from '../../src/errors.js'
import { candidateInterfaces, pickInterface } from '../../src/net.js'
import { mimeForFormat, protocolInfo, sourceProtocolInfo } from '../../src/probe/mime.js'
import { summarize } from '../../src/probe/ffprobe.js'
import { clientLabel, resolveQuirks } from '../../src/quirks.js'

/** @param {string} address @param {boolean} [internal] */
const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null })
const ifaces = /** @type {any} */ ({
  lo0: [v4('127.0.0.1', true)],
  utun3: [v4('100.64.0.2')],
  bridge0: [v4('192.168.64.1')],
  en1: [v4('192.168.1.30')],
  en0: [{ ...v4('fe80::1'), family: 'IPv6' }, v4('192.168.1.20')],
  awdl0: [v4('169.254.1.1')],
})

describe('network interface selection', () => {
  it('skips loopback, VPN, bridges; prefers en0', () => {
    assert.deepEqual(candidateInterfaces(ifaces).map((i) => i.name), ['en0', 'en1'])
    assert.equal(pickInterface(undefined, ifaces).address, '192.168.1.20')
  })
  it('explicit name or IP bypasses the skip list', () => {
    assert.equal(pickInterface('lo0', ifaces).address, '127.0.0.1')
    assert.equal(pickInterface('192.168.1.30', ifaces).name, 'en1')
  })
  it('throws a coded error when nothing matches', () => {
    assert.throws(() => pickInterface('eth9', ifaces), { code: ErrorCode.NO_INTERFACE })
    assert.throws(() => pickInterface(undefined, /** @type {any} */ ({ lo0: [v4('127.0.0.1', true)] })), { code: ErrorCode.NO_INTERFACE })
  })
})

describe('quirks', () => {
  it('matches Samsung via User-Agent or X-AV-Client-Info', () => {
    assert.equal(resolveQuirks({ 'user-agent': 'DLNADOC/1.50 SEC_HHP_[TV] Samsung Q7 Series/1.0' }).name, 'samsung')
    assert.equal(resolveQuirks({ 'x-av-client-info': 'av=5.0; cn="Samsung Electronics"; mn="UE55"' }).name, 'samsung')
    assert.equal(resolveQuirks({ 'user-agent': 'Linux/3.10 UPnP/1.0 LGE WebOS TV/Version 0.9' }).name, 'lg')
    assert.equal(resolveQuirks({ 'user-agent': 'VLC/3.0.21 LibVLC/3.0.21' }).name, 'vlc')
    assert.equal(resolveQuirks({}).name, 'generic')
  })
  it('Samsung aliases MKV', () => {
    assert.equal(resolveQuirks({ 'user-agent': 'SEC_HHP_TV' }).mimeAliases['video/x-matroska'], 'video/x-mkv')
  })
  it('clientLabel prefers friendlyName, then quirk label, then UA product', () => {
    assert.equal(clientLabel({ 'friendlyname.dlna.org': 'Living Room' }), 'Living Room')
    assert.equal(clientLabel({ 'user-agent': 'VLC/3.0.21 LibVLC/3.0.21' }), 'VLC')
    assert.equal(clientLabel({ 'user-agent': 'AppleCoreMedia/1.0.0.21' }), 'AppleCoreMedia')
    assert.equal(clientLabel({}), 'unknown')
  })
})

describe('mime / protocolInfo / ffprobe summary', () => {
  it('protocolInfo', () => {
    assert.equal(protocolInfo('video/mp4'), 'http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000')
    assert.match(protocolInfo('video/mp4', { profile: 'AVC_MP4_HP_HD_AAC' }), /:DLNA\.ORG_PN=AVC_MP4_HP_HD_AAC;DLNA\.ORG_OP=01;/)
    assert.match(sourceProtocolInfo(), /video\/x-matroska/)
    assert.match(sourceProtocolInfo(), /http-get:\*:text\/srt:\*$/)
  })
  it('mimeForFormat corrects lying extensions', () => {
    assert.equal(mimeForFormat('matroska,webm', 'mp4'), 'video/x-matroska')
    assert.equal(mimeForFormat('matroska,webm', 'webm'), 'video/webm')
    assert.equal(mimeForFormat('mov,mp4,m4a,3gp,3g2,mj2', 'mov'), 'video/quicktime')
    assert.equal(mimeForFormat('mov,mp4,m4a,3gp,3g2,mj2', 'mkv'), 'video/mp4')
    assert.equal(mimeForFormat('mpegts', 'mp4'), 'video/mp2t')
    assert.equal(mimeForFormat('avi', 'divx'), 'video/x-msvideo')
  })
  it('summarize ffprobe JSON', () => {
    const s = summarize({
      format: { format_name: 'mov,mp4', duration: '125.5', bit_rate: '4000000' },
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
      ],
    })
    assert.deepEqual(s, {
      container: 'mov,mp4',
      duration: 125.5,
      bitrate: 4_000_000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioChannels: 2,
      sampleRate: 48000,
    })
    assert.deepEqual(summarize({}), {
      container: undefined,
      duration: undefined,
      bitrate: undefined,
      width: undefined,
      height: undefined,
      videoCodec: undefined,
      audioCodec: undefined,
      audioChannels: undefined,
      sampleRate: undefined,
    })
  })
})
