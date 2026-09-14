/**
 * The `settings.plugin.item` slot entry this package contributes.
 *
 * The slot itself is declared by the settings-plugins package — the tab that
 * dispatches it. Importing that declaration (type-only, which is all the
 * purity gate permits) is what makes `PropsRuntime<'settings.plugin.item'>`
 * resolve in the card; re-declaring the slot here would be a second, competing
 * source of truth for its shape.
 *
 * This module adds only what this package owns: the card's locale namespace.
 *
 * @module @wzxm/dsh-mysql/client/slot-contract
 */

// Type-only: load the file that merges `settings.plugin.item` into SlotMap.
// The package entry only `export type`s this module, so `import type {}` from
// `.../client` never applies the augmentation.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client/slot-contract'
import type { MysqlCardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The MySQL card's copy. */
    'dsh-mysql': MysqlCardKey
  }
}
