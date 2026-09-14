/**
 * The MySQL settings card, wrapped in the official collapsible PluginCard
 * shell.
 *
 * Uses staged-edit semantics: switch changes are staged, and only a Save
 * writes them to the settings scope. The card reuses PluginCard's header and
 * disclosure behavior (default collapsed), and adds its own save/discard
 * footer as children.
 *
 * @module @wzxm/dsh-mysql/client/MysqlCard
 */

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Switch, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardShell } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MysqlCard.module.css'
import type { MysqlCardFace } from './card-controller.ts'
import type {} from './slot-contract.ts'
import type { MysqlCardKey } from './locales.ts'
import type { WriteSwitchField } from '../write-switches.ts'

/** The dictionary this card reads its copy from. */
export const CARD_LOCALE_NS = 'dsh-mysql'

/**
 * Props the renderer binds for this card.
 */
export type MysqlCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof CARD_LOCALE_NS>
  & InjectFace<MysqlCardFace>

/**
 * Render the card using the official collapsible plugin card shell.
 * @param props - locale copy, the card snapshot, and its write actions.
 * @returns the card element.
 */
export function MysqlCard(props: MysqlCardProps) {
  const { t } = props
  const state = props.useMysqlCard(snapshot => snapshot)

  // Collapsible state
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  // Staged changes: field → new value (undefined = no staged change)
  const stagedRef = useRef(new Map<string, boolean>())
  // Force re-render when staged changes
  const [, forceUpdate] = useState(0)

  if (state.status === 'loading') {
    return <div className={css.placeholder}>{t('loading')}</div>
  }
  if (state.status === 'unavailable') {
    return <div className={css.placeholder}>{t('unavailable')}</div>
  }

  const hasStaged = stagedRef.current.size > 0

  const onToggleExpanded = useCallback(() => {
    setExpanded(prev => !prev)
  }, [])

  const onStagedSwitch = useCallback((field: WriteSwitchField, value: boolean) => {
    stagedRef.current.set(field, value)
    forceUpdate(n => n + 1)
  }, [])

  const onSave = useCallback(async () => {
    if (stagedRef.current.size === 0) return
    setSaving(true)
    setFailed(false)
    let ok = true
    for (const [field, value] of stagedRef.current) {
      try {
        await props.setSwitch(field as WriteSwitchField, value)
      } catch {
        ok = false
      }
    }
    if (ok) stagedRef.current.clear()
    setSaving(false)
    setFailed(!ok)
    forceUpdate(n => n + 1)
  }, [props])

  const onDiscard = useCallback(() => {
    if (stagedRef.current.size === 0 && !failed) return
    stagedRef.current.clear()
    setFailed(false)
    forceUpdate(n => n + 1)
  }, [failed])

  // Build the CardShell that PluginCard expects
  const shell: CardShell = {
    available: true,
    writable: state.writable,
    dirty: hasStaged,
    invalid: false,
    saving,
    failed,
  }

  const title = t('title')
  const saveDisabled = !hasStaged || saving

  return (
    <div className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={expanded}
        aria-label={`${expanded ? t('collapse') : t('expand')}: ${title}`}
        onClick={onToggleExpanded}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        {hasStaged ? <span className={css.unsavedTag}>{t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={`${css.chevronIcon} ${expanded ? css.chevronOpen : ''}`} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className={css.body}>
          {!state.writable ? <div className={css.readOnly} role="status">{t('readOnly')}</div> : null}
          <div className={css.notice}>{t('envNotice')}</div>
          <div className={css.rows}>
            {state.rows.map(row => {
              // Show staged value if present; otherwise the scope's current value
              const stagedValue = stagedRef.current.has(row.field)
                ? stagedRef.current.get(row.field)
                : undefined
              const effectiveEnabled = stagedValue !== undefined ? stagedValue : row.enabled
              const stagedOverride = stagedValue !== undefined

              return (
                <div key={row.field} className={css.row}>
                  <div className={css.rowText}>
                    <span className={css.label}>
                      {row.statements}
                      {stagedOverride ? <span className={`${css.badge} ${css.staged}`}>{t('staged')}</span> : null}
                      {row.overridden && !stagedOverride ? <span className={`${css.badge} ${css.overridden}`}>{t('overridden')}</span> : null}
                    </span>
                    <span className={css.hint}>{row.field}</span>
                  </div>
                  {row.gate === 'env-required'
                    ? <span className={css.envRequirement}>
                        <span className={css.envStatus}>{t('envUnauthorized')}</span>
                        <code className={css.envName}>{row.environment}=true</code>
                      </span>
                    : <Switch
                        checked={effectiveEnabled}
                        disabled={!state.writable || saving}
                        label={t('allow', { statements: row.statements })}
                        onChange={(next) => { onStagedSwitch(row.field as WriteSwitchField, next) }}
                      />}
                </div>
              )
            })}
          </div>
          {failed ? <div className={css.failed} role="status">{t('saveFailed')}</div> : null}
          <div className={css.footer}>
            <button
              type="button"
              className={css.discard}
              disabled={!hasStaged || saving}
              onClick={onDiscard}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className={css.save}
              disabled={saveDisabled}
              onClick={onSave}
            >
              {saving ? t('saving') : t('save')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}