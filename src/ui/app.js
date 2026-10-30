import { Box, Text, useInput, useWindowSize } from 'ink'
import { useEffect, useState } from 'react'
import { Clients } from './clients.js'
import { Header } from './header.js'
import { html } from './html.js'
import { LogPane } from './log-pane.js'
import { Streams } from './streams.js'

const FRAME_MS = 250

/**
 * Re-render on any source event, coalesced to FRAME_MS, plus a 1s heartbeat
 * for relative times and the grace countdown.
 * @param {Array<{ on: Function, off: Function, event: string }>} sources
 */
function useTicker (sources) {
  const [, setTick] = useState(0)
  useEffect(() => {
    /** @type {NodeJS.Timeout | undefined} */
    let pending
    const bump = () => {
      if (pending) return
      pending = setTimeout(() => { pending = undefined; setTick((t) => t + 1) }, FRAME_MS)
    }
    for (const s of sources) s.on(s.event, bump)
    const heartbeat = setInterval(bump, 1000)
    return () => {
      for (const s of sources) s.off(s.event, bump)
      clearInterval(heartbeat)
      clearTimeout(pending)
    }
  }, [])
}

/**
 * @param {{
 *   server: import('../server.js').CouchcastServer,
 *   keepAwake: import('../keep-awake.js').KeepAwake,
 *   ring: ReturnType<typeof import('../logger.js').createRingSink>,
 *   initialVerbose: boolean,
 *   onQuit: () => void,
 *   onRescan: () => void,
 * }} props
 */
export function App ({ server, keepAwake, ring, initialVerbose, onQuit, onRescan }) {
  const [verbose, setVerbose] = useState(initialVerbose)
  const { columns, rows } = useWindowSize()
  useTicker([
    { on: server.on.bind(server), off: server.off.bind(server), event: 'update' },
    { on: keepAwake.on.bind(keepAwake), off: keepAwake.off.bind(keepAwake), event: 'change' },
    { on: ring.events.on.bind(ring.events), off: ring.events.off.bind(ring.events), event: 'entry' },
  ])

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) onQuit()
    else if (input === 'v') setVerbose((v) => !v)
    else if (input === 'r') onRescan()
  })

  const state = server.snapshot()
  const now = Date.now()
  const width = Math.max(40, columns)
  const used = 7 + 2 + Math.max(1, Math.min(6, state.clients.length)) + 2 + Math.max(1, Math.min(6, state.streams.length)) + 3
  const logLines = Math.max(3, rows - used - 1)

  return html`
    <${Box} flexDirection="column" width=${width}>
      <${Header} state=${state} keepAwake=${keepAwake} now=${now} />
      <${Clients} clients=${state.clients} now=${now} width=${width} />
      <${Box} height=${1} />
      <${Streams} streams=${state.streams} width=${width} />
      <${Box} height=${1} />
      <${LogPane} entries=${ring.entries()} verbose=${verbose} lines=${logLines} width=${width} />
      <${Box} paddingX=${1}>
        <${Text} dimColor>
          <${Text} bold color="white">q</${Text}> quit  <${Text} bold color="white">v</${Text}> verbose ${verbose ? 'on' : 'off'}  <${Text} bold color="white">r</${Text}> rescan
        </${Text}>
      </${Box}>
    </${Box}>
  `
}
