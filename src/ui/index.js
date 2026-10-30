import { render } from 'ink'
import { App } from './app.js'
import { html } from './html.js'

/**
 * Mount the dashboard in the alternate screen; the terminal is restored on unmount.
 * @param {Parameters<typeof App>[0]} props
 */
export function renderUi (props) {
  return render(html`<${App} ...${props} />`, {
    exitOnCtrlC: false, // App handles ctrl+c so shutdown goes through one path
    alternateScreen: true,
    patchConsole: false,
  })
}
