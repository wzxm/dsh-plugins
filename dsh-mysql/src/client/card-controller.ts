/**
 * The MySQL card's controller: one settings scope projected into the card's
 * snapshot, plus the write actions the card calls.
 *
 * @module @wzxm/dsh-mysql/client/card-controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { projectCardState, type MysqlCardState } from './card-state.ts'
import type { WriteSwitchField } from '../write-switches.ts'

/** The registration-side face the card's slot entry injects. */
export interface MysqlCardFace {
  hooks: {
    /** Card snapshot, bound by the renderer as `useMysqlCard`. */
    mysqlCard: SnapshotStore<MysqlCardState>
  }
  /**
   * Write one switch into the namespace's user layer.
   * @param field - the switch to write.
   * @param value - the value the operator selected.
   */
  setSwitch(field: WriteSwitchField, value: boolean): void
}

/** Bridges the `dsh-mysql` scope onto the card's view state. */
export class MysqlCardController {
  private readonly store: SnapshotStore<MysqlCardState>
  private error: string | undefined

  /**
   * @param scope - the bound settings scope for the `dsh-mysql` namespace.
   */
  constructor(private readonly scope: SettingsScope<unknown>) {
    this.store = createSnapshotStore(projectCardState(this.scope.getSnapshot()))
    this.scope.subscribe(() => { this.publish() })
  }

  /** Re-derive the snapshot from the scope, preserving any pending error. */
  private publish(): void {
    this.store.set({ ...projectCardState(this.scope.getSnapshot()), error: this.error })
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its write action.
   */
  inject(): MysqlCardFace {
    return {
      hooks: { mysqlCard: this.store },
      setSwitch: (field, value) => {
        // A rejected write leaves the failure on screen rather than reverting
        // silently; the scope's own recovery read refreshes the switch values.
        this.error = undefined
        this.publish()
        void this.scope.set(field, value).catch((cause: unknown) => {
          this.error = cause instanceof Error ? cause.message : String(cause)
          this.publish()
        })
      },
    }
  }
}
