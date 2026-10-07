// ------------------------------------------------------------
// ELSE (OTHER) branch cooldown — pure config helpers.
//
// A condition's `no` branch is the one that fires on *every* message
// that doesn't match the IF/ELSE IF predicates. For an automation
// wired to "any inbound message", a contact sending five messages in
// a row fired the ELSE actions five times. Switching the cooldown on
// suppresses re-fires for a window, keyed on (automation, contact).
//
// This module is deliberately dependency-free (types only) so the
// builder can read the same defaults the engine runs with. The actual
// DB claim lives in else-cooldown-claim.ts, which needs the
// service-role client and therefore never loads into a client bundle.
// ------------------------------------------------------------

import type { ElseCooldownConfig, ElseCooldownUnit } from '@/types'

export const DEFAULT_ELSE_COOLDOWN: ElseCooldownConfig = {
  enabled: false,
  amount: 5,
  unit: 'minutes',
}

export const ELSE_COOLDOWN_UNITS: readonly ElseCooldownUnit[] = [
  'seconds',
  'minutes',
  'hours',
  'days',
]

const UNIT_SECONDS: Record<ElseCooldownUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
}

/**
 * Read the cooldown off a condition step config, filling in defaults
 * for anything missing. Normalizes rather than validates so configs
 * saved before this feature load unchanged (no `else_cooldown` key at
 * all → the default, which is `enabled: false` → today's behaviour).
 */
export function elseCooldownFrom(cfg: unknown): ElseCooldownConfig {
  const raw = (cfg as { else_cooldown?: unknown } | null | undefined)?.else_cooldown
  if (!raw || typeof raw !== 'object') return DEFAULT_ELSE_COOLDOWN
  const d = raw as Partial<ElseCooldownConfig>
  const amount =
    typeof d.amount === 'number' && Number.isFinite(d.amount)
      ? d.amount
      : DEFAULT_ELSE_COOLDOWN.amount
  const unit =
    d.unit && d.unit in UNIT_SECONDS ? d.unit : DEFAULT_ELSE_COOLDOWN.unit
  return { enabled: d.enabled === true, amount, unit }
}

/**
 * Seconds the cooldown lasts. `0` means "no cooldown" — switched off,
 * or an unusable value, both of which fall through to the branch
 * running every time (the pre-feature behaviour).
 */
export function elseCooldownSeconds(cfg: unknown): number {
  const normalized = elseCooldownFrom(cfg)
  if (!normalized.enabled) return 0
  const per = UNIT_SECONDS[normalized.unit]
  if (!per || !Number.isFinite(normalized.amount) || normalized.amount <= 0) return 0
  return Math.round(normalized.amount * per)
}
