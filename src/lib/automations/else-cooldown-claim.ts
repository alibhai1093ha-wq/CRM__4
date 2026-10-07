// ------------------------------------------------------------
// ELSE (OTHER) branch cooldown — the database side.
//
// Claiming a cooldown must be one atomic operation: two concurrent
// deliveries for the same contact must not both read "no row yet" and
// both run the branch. That logic lives in Postgres as
// `claim_else_cooldown` (migration 048) — an INSERT ... ON CONFLICT
// DO UPDATE whose WHERE clause decides, under a single lock, whether
// this call is inside the window. Timestamps come from DB NOW(),
// never the app clock, so skewed instances can't disagree about what
// "5 minutes ago" means.
//
// Keyed on (automation_id, contact_id), NOT the condition step id:
// `replaceSteps` (steps-tree.ts) deletes and re-inserts every step row
// with a fresh UUID on each save, which would silently re-arm the
// cooldown on any edit to the automation.
//
// Server-side only — imports the service-role client.
// ------------------------------------------------------------

import { supabaseAdmin } from './admin-client'
import { elseCooldownSeconds } from './else-cooldown'
import type { ConditionStepConfig } from '@/types'

export type CooldownClaim = 'granted' | 'denied' | 'error'

/**
 * Take (or check) this contact's cooldown window for an automation.
 *
 *   granted — the window is open: run the branch (row stamped).
 *   denied  — the branch ran less than `cooldownSeconds` ago: skip.
 *   error   — the check itself failed; callers skip the branch too
 *             (fail-closed), because silently dropping the cooldown
 *             is the failure mode this feature exists to prevent.
 *
 * `cooldownSeconds <= 0` short-circuits to 'granted' with no round
 * trip, so a disabled/absent cooldown costs nothing.
 *
 * If migration 048 hasn't been applied yet the RPC simply isn't there
 * (PostgREST PGRST202 / Postgres 42P01). That must not break existing
 * automations, so it degrades to 'granted' with a warning — a missing
 * table is not a reason to stop running ELSE branches.
 */
export async function claimElseCooldown(opts: {
  automationId: string
  contactId: string
  cooldownSeconds: number
}): Promise<CooldownClaim> {
  if (!(opts.cooldownSeconds > 0)) return 'granted'

  const { data, error } = await supabaseAdmin().rpc('claim_else_cooldown', {
    p_automation_id: opts.automationId,
    p_contact_id: opts.contactId,
    p_cooldown_seconds: opts.cooldownSeconds,
  })

  if (error) {
    if (isSchemaMissing(error)) {
      console.warn(
        '[else-cooldown] claim_else_cooldown unavailable (migration 048 not applied) — running the ELSE branch without a cooldown:',
        error.message,
      )
      return 'granted'
    }
    console.error('[else-cooldown] claim failed:', error)
    return 'error'
  }

  // The RPC returns FALSE while the window is still open.
  return data === false ? 'denied' : 'granted'
}

/** Convenience wrapper for the engine: config → seconds → claim. */
export async function claimElseCooldownForStep(
  cfg: ConditionStepConfig,
  ids: { automationId: string; contactId: string },
): Promise<CooldownClaim> {
  return claimElseCooldown({
    automationId: ids.automationId,
    contactId: ids.contactId,
    cooldownSeconds: elseCooldownSeconds(cfg),
  })
}

/** True when the error means "this RPC/table doesn't exist yet". */
function isSchemaMissing(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === '42P01' || error.code === '42883') return true // undefined_table / undefined_function
  if (error.code === 'PGRST202' || error.code === 'PGRST205') return true // PostgREST "could not find ..."
  return /could not find the (function|table|relation)|does not exist/i.test(error.message ?? '')
}
