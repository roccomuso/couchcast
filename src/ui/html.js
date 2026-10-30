import htm from 'htm'
import { createElement } from 'react'

/**
 * JSX-free React: html`<${Box}>...</${Box}>`
 * (Cast: htm's .d.ts is CJS-flavored, which NodeNext resolves to the namespace.)
 * @type {(strings: TemplateStringsArray, ...values: any[]) => any}
 */
export const html = /** @type {any} */ (htm).bind(createElement)
