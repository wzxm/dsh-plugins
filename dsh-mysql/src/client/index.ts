/**
 * MySQL settings surface, browser half.
 *
 * Contributes one card to the settings page's configurable-plugins tab, keyed
 * by the `dsh-mysql` settings namespace the host half registers. The tab pairs
 * the two without knowing what either means, which is what lets a plugin
 * distributed outside the harness repository ship its own card.
 *
 * @module @wzxm/dsh-mysql/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slots service Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings shell's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { MysqlCard } from './MysqlCard.tsx'
import { MysqlCardController, type MysqlCardFace } from './card-controller.ts'
import { CARD_LOCALE_NS, type MysqlCardProps } from './MysqlCard.tsx'
import { en, zh } from './locales.ts'
import { WRITE_SWITCH_NAMESPACE } from '../write-switches.ts'
// Type-only: pulls the card slot declaration this package registers into.
import type {} from './slot-contract.ts'

export type { MysqlCardProps } from './MysqlCard.tsx'
export type { MysqlCardFace } from './card-controller.ts'
export type { MysqlCardState, SwitchRow, SwitchGate } from './card-state.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the card's copy and its slot contribution.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(CARD_LOCALE_NS, { zh, en }),
    'dsh-mysql: card dictionaries',
  )

  const card = new MysqlCardController(ctx.settingsScope.bind({ namespace: WRITE_SWITCH_NAMESPACE }))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    // Keyed by the settings namespace: the tab dispatches this card only when
    // the host serves that namespace, so an uncomposed plugin leaves no trace.
    key: WRITE_SWITCH_NAMESPACE,
    locale: CARD_LOCALE_NS,
    inject: (): MysqlCardFace => card.inject(),
  }, MysqlCard))
}
