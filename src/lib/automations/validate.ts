import type { AutomationTriggerType } from '@/types'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  message: string
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: Record<string, StepLike[]>
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    })
    return issues
  }
  walk(steps, '', issues)
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues)
    if (s.step_type === 'condition' && s.branches) {
      for (const [label, bucket] of Object.entries(s.branches)) {
        if (bucket && bucket.length > 0) walk(bucket, `${path}.${label}.`, issues)
      }
    }
  })
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message': {
      const media = typeof c.media === 'object' && c.media !== null
        ? (c.media as { type?: unknown; url?: unknown })
        : undefined
      if (!nonEmpty(c.text) && !(media && typeof media.url === 'string' && media.url.trim())) {
        issues.push({
          path: `${path}.text`,
          message: 'message text or an image/video attachment is required',
        })
      }
      if (media && media.url) {
        if (media.type !== 'image' && media.type !== 'video') {
          issues.push({ path: `${path}.media.type`, message: 'only image or video attachments are supported' })
        }
        if (typeof media.url !== 'string' || !media.url.trim()) {
          issues.push({ path: `${path}.media.url`, message: 'attachment needs an uploaded file' })
        }
      }
      break
    }
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c)
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error })
      }
      break
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: 'template name is required' })
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: 'field name is required' })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'field value is required' })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: 'pipeline is required' })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'wait amount must be greater than 0' })
      }
      if (!['seconds', 'minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be seconds, minutes, hours, or days',
        })
      }
      break
    case 'condition':
      validatePredicate(c, path, issues)
      const elseIfs = Array.isArray(c.else_ifs) ? c.else_ifs : []
      elseIfs.forEach((ei, i) => {
        validatePredicate(ei as Record<string, unknown>, `${path}.else_ifs[${i}]`, issues)
      })
      validateElseCooldown(c, path, issues)
      break
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required' })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL' })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings' })
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains' &&
      cfg.match_type !== 'word'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact", "contains" or "word"',
      })
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({ path: 'trigger.schedule', message: 'schedule is required' })
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' })
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      })
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
      })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

function validatePredicate(
  c: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!nonEmpty(c.subject)) {
    issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
  }
  // `message_content` is the one subject that has no operand: the
  // builder hides that input for it (PredicateFields only renders the
  // operand when subject !== "message_content") and the engine compares
  // `value` against the message text directly. Requiring operand here
  // made an otherwise-valid "message contains <keyword>" condition fail
  // activation with "condition operand is required" — the Save error
  // users hit. Every other subject still needs its operand (tag id,
  // field name, "HH:mm-HH:mm").
  if (c.subject !== 'message_content' && !nonEmpty(c.operand)) {
    issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
  }
  if (c.subject === 'message_content' && !nonEmpty(c.value)) {
    issues.push({ path: `${path}.value`, message: 'condition value is required' })
  }
  if (
    c.operator != null &&
    c.operator !== 'contains' &&
    c.operator !== 'exact_match'
  ) {
    issues.push({
      path: `${path}.operator`,
      message: 'condition operator must be "contains" or "exact_match"',
    })
  }
}

/**
 * The per-contact ELSE (OTHER) branch cooldown, when switched on.
 * Only checked while `enabled` — a saved-but-off cooldown keeps its
 * default (5 minutes) and never blocks activation.
 */
function validateElseCooldown(
  c: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  const cd = c.else_cooldown
  if (!cd || typeof cd !== 'object') return
  const d = cd as Record<string, unknown>
  if (d.enabled !== true) return
  if (typeof d.amount !== 'number' || !Number.isFinite(d.amount) || d.amount <= 0) {
    issues.push({
      path: `${path}.else_cooldown.amount`,
      message: 'ELSE cooldown amount must be greater than 0',
    })
  }
  if (!['seconds', 'minutes', 'hours', 'days'].includes(String(d.unit))) {
    issues.push({
      path: `${path}.else_cooldown.unit`,
      message: 'ELSE cooldown unit must be seconds, minutes, hours, or days',
    })
  }
}
