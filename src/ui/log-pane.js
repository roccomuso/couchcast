import { Box, Text } from 'ink'
import { html } from './html.js'
import { truncate } from './format.js'

const COLORS = /** @type {const} */ ({ debug: 'gray', info: undefined, warn: 'yellow', error: 'red' })

/**
 * @param {{ entries: import('../logger.js').LogEntry[], verbose: boolean, lines: number, width: number }} props
 */
export function LogPane ({ entries, verbose, lines, width }) {
  const visible = (verbose ? entries : entries.filter((e) => e.level !== 'debug')).slice(-lines)
  return html`
    <${Box} flexDirection="column" paddingX=${1} height=${lines + 1}>
      <${Text} bold>Log${verbose ? html`<${Text} dimColor> (verbose)</${Text}>` : ''}</${Text}>
      ${visible.map((e, i) => {
        const time = new Date(e.time).toTimeString().slice(0, 8)
        const text = `${e.scope ? `[${e.scope}] ` : ''}${e.msg.split('\n')[0]}`
        return html`
          <${Text} key=${`${e.time}-${i}`} wrap="truncate">
            <${Text} dimColor>${time} </${Text}><${Text} color=${COLORS[e.level]}>${truncate(text, width - 13)}</${Text}>
          </${Text}>`
      })}
    </${Box}>
  `
}
