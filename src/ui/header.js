import { Box, Text } from 'ink'
import { formatCountdown, tildify } from './format.js'
import { html } from './html.js'

/**
 * @param {{ keepAwake: import('../keep-awake.js').KeepAwake, now: number }} props
 */
function KeepAwakeStatus ({ keepAwake, now }) {
  const tool = keepAwake.tool
  switch (keepAwake.state) {
    case 'active':
      return html`<${Text} color="green">● awake <${Text} dimColor>(${tool})</${Text}></${Text}>`
    case 'grace':
      return html`<${Text} color="yellow">◐ awake, sleep allowed in ${formatCountdown(keepAwake.graceEndsAt - now)}</${Text}>`
    case 'idle':
      return html`<${Text} dimColor>○ idle (sleep allowed)</${Text}>`
    case 'disabled':
      return html`<${Text} dimColor>off (--no-keep-awake)</${Text}>`
    default:
      return html`<${Text} color="yellow">unsupported on this system</${Text}>`
  }
}

/**
 * @param {{
 *   state: import('../server.js').ServerState,
 *   keepAwake: import('../keep-awake.js').KeepAwake,
 *   now: number,
 * }} props
 */
export function Header ({ state, keepAwake, now }) {
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX=${1}>
      <${Text} bold color="cyan">${state.name}</${Text}>
      <${Text} wrap="truncate-middle"><${Text} dimColor>Serving  </${Text}>${tildify(state.dir)} <${Text} dimColor>·</${Text}> <${Text} bold>${state.videoCount}</${Text}> videos${state.ffprobe ? '' : html`<${Text} dimColor> (no ffprobe)</${Text}>`}</${Text}>
      <${Text} wrap="truncate-middle"><${Text} dimColor>URL      </${Text}>${state.descriptionUrl}</${Text}>
      <${Text}><${Text} dimColor>Network  </${Text}>${state.interface} <${Text} dimColor>(${state.address})</${Text}></${Text}>
      <${Text}><${Text} dimColor>Sleep    </${Text}><${KeepAwakeStatus} keepAwake=${keepAwake} now=${now} /></${Text}>
    </${Box}>
  `
}
