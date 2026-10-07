-- ============================================================
-- 048_else_cooldown.sql — per-contact cooldown for a condition's
-- ELSE (OTHER) branch
--
-- Problem this solves:
--   A condition's `no` branch is the one that fires for EVERY inbound
--   message that matches neither the IF nor any ELSE IF predicate. For
--   an automation watching general traffic, one contact sending a
--   string of messages re-ran the ELSE actions on each of them. The
--   feature this migration supports lets an automation author switch
--   on a per-contact cooldown: once the ELSE branch has fired for a
--   contact, re-fires are suppressed for a window.
--
-- Why the key is (automation_id, contact_id):
--   Not the condition step id. `replaceSteps` (steps-tree.ts) deletes
--   and re-inserts every step row with a FRESH uuid on each save, so a
--   step-keyed counter would be silently re-armed by any edit to the
--   automation. The automation id is stable for the life of the
--   automation, which is the lifetime the author actually cares about.
--
-- Why a function and not a read-then-write in the app:
--   Two concurrent deliveries for the same contact must not both read
--   "no row yet" and both run the branch. The upsert below claims the
--   window atomically; the DO UPDATE ... WHERE clause decides inside
--   Postgres whether this call is inside or outside the window.
--   Timestamps come from NOW() (the database clock), never the app
--   clock, so skewed instances can't disagree about what "5 minutes
--   ago" means.
--
-- Failure mode:
--   A claim returns FALSE when the window is still open (callers skip
--   the ELSE branch). TRUE claims/stamps the row. Callers treat a
--   transport error as "skip" too — silently dropping the cooldown is
--   the exact behaviour this table exists to prevent.
--
-- Service-role only, like automation_pending_executions (006): no
-- user-facing policy, and the function is revoked from anon and
-- authenticated so an authenticated user can't probe other accounts'
-- automation/contact pairs via RPC.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_else_cooldowns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_seconds >= 0),
  last_triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_else_cooldowns_unique UNIQUE (automation_id, contact_id)
);

-- Account-scoped housekeeping (bulk delete on account removal) stays
-- cheap; the UNIQUE constraint's index already serves the upsert.
CREATE INDEX IF NOT EXISTS idx_automation_else_cooldowns_account
  ON automation_else_cooldowns(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON automation_else_cooldowns;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON automation_else_cooldowns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE automation_else_cooldowns ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy — all access is server-side
-- via the service-role key (see comment block above).

-- ============================================================
-- claim_else_cooldown(automation, contact, window) → boolean
--
--   TRUE  — the window was open (row inserted/stamped): run the ELSE
--           branch.
--   FALSE — the ELSE branch ran within `p_cooldown_seconds` ago (or
--           the automation does not exist): skip it.
--
-- p_cooldown_seconds <= 0 short-circuits to TRUE without touching
-- data, so a disabled/absent cooldown costs no write.
-- ============================================================
CREATE OR REPLACE FUNCTION claim_else_cooldown(
  p_automation_id UUID,
  p_contact_id UUID,
  p_cooldown_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed BOOLEAN;
BEGIN
  IF p_cooldown_seconds IS NULL OR p_cooldown_seconds <= 0 THEN
    RETURN TRUE;
  END IF;

  -- INSERT path claims the window for the first fire; the ON CONFLICT
  -- path re-checks it for every later fire. A failed DO UPDATE WHERE
  -- returns no row, so v_claimed stays NULL → FALSE (still cooling).
  INSERT INTO automation_else_cooldowns AS ec
      (automation_id, contact_id, account_id, cooldown_seconds,
       last_triggered_at, updated_at)
    SELECT a.id, p_contact_id, a.account_id, p_cooldown_seconds, NOW(), NOW()
    FROM automations a
    WHERE a.id = p_automation_id
  ON CONFLICT (automation_id, contact_id)
  DO UPDATE
    SET last_triggered_at = EXCLUDED.last_triggered_at,
        cooldown_seconds = EXCLUDED.cooldown_seconds,
        updated_at = EXCLUDED.updated_at
    WHERE ec.last_triggered_at <= NOW() - make_interval(secs => p_cooldown_seconds)
  RETURNING TRUE INTO v_claimed;

  RETURN COALESCE(v_claimed, FALSE);
END;
$$;

-- Only the service role may call it (the engine uses the service-role
-- client). Locking anon/authenticated out keeps an authenticated user
-- from claiming — and therefore probing — cooldown rows for
-- automations and contacts outside their own account.
REVOKE ALL ON FUNCTION claim_else_cooldown(UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_else_cooldown(UUID, UUID, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION claim_else_cooldown(UUID, UUID, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_else_cooldown(UUID, UUID, INTEGER) TO service_role;
