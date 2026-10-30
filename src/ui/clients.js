import { Box, Text } from 'ink'
import { formatAgo, truncate } from './format.js'
import { html } from './html.js'

/**
 * @param {{ clients: import('../server.js').ClientInfo[], now: number, width: number }} props
 */
export function Clients ({ clients, now, width }) {
  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Text} bold>Clients <${Text} dimColor>(${clients.length})</${Text}></${Text}>
      ${clients.length === 0
        ? html`<${Text} dimColor>  none yet: open VLC → Network → Local Network, or your TV's media app</${Text}>`
        : clients.slice(0, 6).map((c) => html`
          <${Box} key=${c.address}>
            <${Box} width=${17}><${Text}>  ${c.address}</${Text}></${Box}>
            <${Box} width=${16}><${Text} color="magenta">${truncate(c.label, 15)}</${Text}></${Box}>
            <${Box} width=${9}><${Text} dimColor>${formatAgo(now - c.lastSeen)}</${Text}></${Box}>
            <${Text} dimColor wrap="truncate">${truncate(c.userAgent, Math.max(0, width - 46))}</${Text}>
          </${Box}>`)}
    </${Box}>
  `
}
