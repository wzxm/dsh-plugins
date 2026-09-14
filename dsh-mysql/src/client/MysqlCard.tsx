/**
 * The MySQL settings card.
 *
 * Renders one switch per SQL write kind. The composition layer (the profile's
 * `DSH_MYSQL_ALLOW_*` variables, surfaced as the scope's `base`) is the
 * ceiling, so a switch the profile left off is shown disabled rather than
 * hidden or silently ineffective — see `card-state.ts` for why.
 *
 * @module @wzxm/dsh-mysql/client/MysqlCard
 */

import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MysqlCard.module.css'
import type { MysqlCardFace } from './card-controller.ts'
import type {} from './slot-contract.ts'
import type { MysqlCardKey } from './locales.ts'

/** The dictionary this card reads its copy from. */
export const CARD_LOCALE_NS = 'dsh-mysql'

/**
 * Props the renderer binds for this card.
 *
 * The business face arrives spread (not as an `inject` member): the renderer
 * binds the registration's inject factory, so `useMysqlCard` and `setSwitch`
 * are top-level props.
 */
export type MysqlCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof CARD_LOCALE_NS>
  & InjectFace<MysqlCardFace>

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and its write actions.
 * @returns the card element.
 */
export function MysqlCard(props: MysqlCardProps) {
  const { t } = props
  const state = props.useMysqlCard(snapshot => snapshot)

  if (state.status === 'loading') {
    return <ul className={css.card}><li className={css.muted}>{t('loading')}</li></ul>
  }
  if (state.status === 'unavailable') {
    return <ul className={css.card}><li className={css.muted}>{t('unavailable')}</li></ul>
  }

  return (
    <ul className={css.card}>
      <li className={css.head}>
        <span className={css.name}>{t('title')}</span>
        <span className={css.description}>{t('description')}</span>
      </li>
      <li className={css.notice}>{t('envNotice')}</li>
      <li className={css.rows}>
        {state.rows.map(row => (
          <div key={row.field} className={css.row}>
            <div className={css.rowText}>
              <span className={css.label}>
                {t('allow', { statements: row.statements })}
                {row.overridden ? <span className={`${css.badge} ${css.overridden}`}>{t('overridden')}</span> : null}
                {row.gate === 'env-required'
                  ? <span className={css.badge}>{t('gated')}</span>
                  : null}
              </span>
              <span className={css.hint}>{row.field}</span>
            </div>
            <Switch
              checked={row.enabled}
              // A kind the profile never authorized cannot be granted here:
              // the MCP server would still refuse it.
              disabled={!state.writable || (row.gate === 'env-required' && !row.enabled)}
              label={t('allow', { statements: row.statements })}
              title={row.gate === 'env-required' ? t('gated') : undefined}
              onChange={(next) => { props.setSwitch(row.field, next) }}
            />
          </div>
        ))}
      </li>
      {state.error === undefined ? null : <li className={css.error}>{state.error}</li>}
      {state.writable ? null : <li className={css.muted}>{t('readOnly')}</li>}
    </ul>
  )
}
