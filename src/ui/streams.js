import { Box, Text } from 'ink'
import { bar, formatBytes, formatRate, truncate } from './format.js'
import { html } from './html.js'

/**
 * @param {{ streams: import('../stream/index.js').StreamSnapshot[], width: number }} props
 */
export function Streams ({ streams, width }) {
  const titleWidth = Math.max(12, width - 62)
  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Text} bold>Streams <${Text} dimColor>(${streams.length})</${Text}></${Text}>
      ${streams.length === 0
        ? html`<${Text} dimColor>  nothing playing</${Text}>`
        : streams.slice(0, 6).map((s) => {
          const pos = s.start + s.bytesSent
          const pct = s.size > 0 ? pos / s.size : 0
          return html`
            <${Box} key=${s.id}>
              <${Box} width=${titleWidth + 2}><${Text}>  ${truncate(s.title, titleWidth)}</${Text}></${Box}>
              <${Box} width=${16}><${Text} color="magenta">${truncate(s.client.label, 15)}</${Text}></${Box}>
              <${Text} color="green">${bar(pct, 16)}</${Text}>
              <${Box} width=${6} justifyContent="flex-end"><${Text}>${Math.floor(pct * 100)}%</${Text}></${Box}>
              <${Box} width=${12} justifyContent="flex-end"><${Text} color="cyan">${formatRate(s.bytesPerSec)}</${Text}></${Box}>
              <${Box} width=${11} justifyContent="flex-end"><${Text} dimColor>${formatBytes(s.size)}</${Text}></${Box}>
            </${Box}>`
        })}
    </${Box}>
  `
}
