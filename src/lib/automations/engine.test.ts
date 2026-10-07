import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    /** Row the contact_field condition reads for the operand column. */
    contactField: null as Record<string, unknown> | null,
    /** Count returned for a tag_presence condition lookup. */
    tagCount: 0,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as {
      table: string;
      filters: [string, string, unknown][];
      payload?: unknown;
    }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    logInserts: [] as Record<string, unknown>[],
    logUpdates: [] as Record<string, unknown>[],
    /** Windows claimed through the claim_else_cooldown RPC, in order. */
    cooldownCalls: [] as Record<string, unknown>[],
    /** Simulated (automation:contact) → last claim, ms epoch. */
    cooldowns: new Map<string, number>(),
    /** When set, every cooldown claim fails with this PostgREST error. */
    cooldownRpcError: null as { code: string; message: string } | null,
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters, payload: ops.payload });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.contactField ?? state.owned, error: null };
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === "contact_custom_values") {
      if (type === "upsert") {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "automations") return { data: state.automations, error: null };
    if (table === "automation_logs") {
      if (type === "insert") {
        state.logInserts.push(ops.payload as Record<string, unknown>);
        return { data: { id: "log1" }, error: null };
      }
      if (type === "update") {
        state.logUpdates.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: "success" }, error: null };
    }
    if (table === "automation_steps") {
      // Scoped reads: top-level scope uses .is('parent_step_id', null);
      // branch recursion uses .eq('parent_step_id', X).eq('branch', Y).
      const parentIsNull = ops.filters.some(
        ([method, key]) => method === "is" && key === "parent_step_id",
      );
      const parentEq = ops.filters.find(
        ([method, key]) => method === "eq" && key === "parent_step_id",
      );
      const branchEq = ops.filters.find(
        ([method, key]) => method === "eq" && key === "branch",
      );
      let rows = state.steps;
      if (parentIsNull) rows = rows.filter((s) => s.parent_step_id == null);
      if (parentEq) rows = rows.filter((s) => s.parent_step_id === parentEq[2]);
      if (branchEq) rows = rows.filter((s) => s.branch === branchEq[2]);
      return { data: rows, error: null };
    }
    if (table === "contact_tags") {
      // .select('id', { count: 'exact', head: true }) resolves via .then()
      return { data: null, error: null, count: state.tagCount };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      gte: () => b,
      is: (k: string, v: unknown) => (ops.filters.push(["is", k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      // increment_automation_execution_count (and anything else) is a
      // fire-and-forget call; claim_else_cooldown is simulated against
      // state.cooldowns so tests can exercise the real window logic.
      rpc: (fn: string, params?: Record<string, unknown>) => {
        if (fn !== "claim_else_cooldown") return Promise.resolve({ error: null });
        state.cooldownCalls.push(params ?? {});
        if (state.cooldownRpcError) {
          return Promise.resolve({ data: null, error: state.cooldownRpcError });
        }
        const key = `${params?.p_automation_id}:${params?.p_contact_id}`;
        const windowMs = (Number(params?.p_cooldown_seconds) || 0) * 1000;
        const now = Date.now();
        const last = state.cooldowns.get(key);
        if (last !== undefined && now - last < windowMs) {
          return Promise.resolve({ data: false, error: null });
        }
        state.cooldowns.set(key, now);
        return Promise.resolve({ data: true, error: null });
      },
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import { runAutomationsForTrigger, triggerMatches } from "./engine";
import type { Automation, AutomationLogStepResult, KeywordMatchTriggerConfig } from "@/types";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.contactField = null;
  h.state.tagCount = 0;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.logInserts = [];
  h.state.logUpdates = [];
  h.state.cooldownCalls = [];
  h.state.cooldowns = new Map();
  h.state.cooldownRpcError = null;
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(["eq", "id", "c1"]);
    expect(filters).toContainEqual(["eq", "account_id", ACCOUNT]);
  });
});

describe("automation_logs — status is seeded pessimistically (issue #409)", () => {
  it("writes the log row as 'failed' before any step runs", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The insert happens before execution, so a run killed mid-flight must
    // not leave behind a row that claims it succeeded.
    expect(h.state.logInserts).toHaveLength(1);
    expect(h.state.logInserts[0]).toMatchObject({
      status: "failed",
      steps_executed: [],
    });
  });

  it("still promotes the log to 'success' once the steps complete", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The seed is only a floor — the outermost scope still writes the real
    // verdict, so a completed run reports success as it always did.
    const withStatus = h.state.logUpdates.filter((u) => "status" in u);
    expect(withStatus.at(-1)).toMatchObject({ status: "success" });
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe("send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)", () => {
  it("refuses a private / link-local destination and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep("http://169.254.169.254/latest/meta-data/")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain("automation_steps");
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "send_webhook",
    position: 0,
    parent_step_id: null,
    step_config: { url, headers: { "Metadata-Flavor": "Google" }, body_template: "{}" },
  };
}

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe("triggerMatches — interactive_reply", () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "menu step",
      trigger_type: "interactive_reply",
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches when the tapped id is in reply_ids (exact)", () => {
    expect(
      triggerMatches(automation(["yes", "no"]), { interactive_reply_id: "yes" }),
    ).toBe(true);
  });

  it("does not match a different id", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "maybe" }),
    ).toBe(false);
  });

  it("does not match on a substring (exact only)", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "yes_please" }),
    ).toBe(false);
  });

  it("does not match when no reply id is present or config is empty", () => {
    expect(triggerMatches(automation(["yes"]), {})).toBe(false);
    expect(triggerMatches(automation([]), { interactive_reply_id: "yes" })).toBe(false);
  });
});

describe("triggerMatches — tag_added", () => {
  function automation(tagId?: string): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "tag follow-up",
      trigger_type: "tag_added",
      trigger_config: tagId ? { tag_id: tagId } : {},
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches only the exact tag id", () => {
    expect(triggerMatches(automation("tag-a"), { tag_id: "tag-a" })).toBe(true);
    expect(triggerMatches(automation("tag-a"), { tag_id: "tag-ab" })).toBe(false);
  });

  it("fails closed when the config or event tag is missing", () => {
    expect(triggerMatches(automation(), { tag_id: "tag-a" })).toBe(false);
    expect(triggerMatches(automation("tag-a"), {})).toBe(false);
    expect(triggerMatches(automation("tag-a"), undefined)).toBe(false);
  });
});

describe("tag_added — conversation policy", () => {
  it("records a clear failed step when the contact has no conversation", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [{
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "tag outreach",
      trigger_type: "tag_added",
      trigger_config: { tag_id: "tag-a" },
      is_active: true,
    }];
    h.state.steps = [{
      id: "s1",
      automation_id: "a1",
      step_type: "send_message",
      position: 0,
      parent_step_id: null,
      step_config: { text: "Hello" },
    }];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: "c1",
      context: { tag_id: "tag-a" },
    });

    expect(h.state.logUpdates).toContainEqual(expect.objectContaining({
      status: "failed",
      error_message: "tag_added automation cannot send: contact has no existing conversation",
    }));
  });
});

describe("triggerMatches — keyword_match", () => {
  function automation(
    cfg: Partial<KeywordMatchTriggerConfig> & { keywords: string[] },
  ): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "kw",
      trigger_type: "keyword_match",
      trigger_config: { match_type: "contains", ...cfg },
      is_active: true,
    } as unknown as Automation;
  }

  const on = (a: Automation, text: string) =>
    triggerMatches(a, { message_text: text });

  it("keeps `contains` as a raw substring test", () => {
    // Issue #409 asked for this to become word-boundary matching. It
    // deliberately did NOT change: existing automations relying on
    // substring behaviour ("cat" firing on "category") must keep working,
    // and `contains` is the builder's default. `word` is the opt-in fix.
    expect(on(automation({ keywords: ["k"] }), "thanks")).toBe(true);
    expect(on(automation({ keywords: ["cat"] }), "category")).toBe(true);
  });

  it("`word` matches only standalone words", () => {
    const a = automation({ keywords: ["k"], match_type: "word" });
    expect(on(a, "thanks")).toBe(false);
    expect(on(a, "k")).toBe(true);
    expect(on(a, "press k to continue")).toBe(true);
    expect(on(a, "press K!")).toBe(true);
  });

  it("`word` respects punctuation and line edges around the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "word" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi!")).toBe(true);
    expect(on(a, "(hi)")).toBe(true);
    expect(on(a, "say hi.")).toBe(true);
    expect(on(a, "this")).toBe(false);
    expect(on(a, "hiya")).toBe(false);
  });

  it("`word` handles a keyword that itself carries punctuation", () => {
    // `\b` can't do this: /\bhi!\b/ demands a word char after the "!",
    // so it never matches. Hence the lookaround implementation.
    const a = automation({ keywords: ["hi!"], match_type: "word" });
    expect(on(a, "say hi!")).toBe(true);
    expect(on(a, "hi! there")).toBe(true);
  });

  it("`word` treats regex metacharacters in a keyword as literal", () => {
    // Account-supplied free text — an unescaped "(" would throw.
    const a = automation({ keywords: ["c++ (beginner)"], match_type: "word" });
    expect(on(a, "I want the c++ (beginner) course")).toBe(true);
    expect(on(a, "I want the cxx beginner course")).toBe(false);
    expect(() => on(automation({ keywords: ["("], match_type: "word" }), "(")).not.toThrow();
  });

  it("`word` is case-insensitive unless case_sensitive is set", () => {
    expect(on(automation({ keywords: ["Hi"], match_type: "word" }), "hi")).toBe(true);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "hi",
      ),
    ).toBe(false);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "Hi",
      ),
    ).toBe(true);
  });

  it("`word` finds a space-delimited keyword in a non-Latin script", () => {
    // ASCII `\b` fails outright here — every character of "안녕" is a
    // non-word character to it, so /\b안녕\b/ matches nothing.
    const a = automation({ keywords: ["안녕"], match_type: "word" });
    expect(on(a, "안녕")).toBe(true);
    expect(on(a, "저기 안녕 하세요")).toBe(true);
    // Documented limitation, not an accident: a language written without
    // spaces has no word edge inside a run of characters.
    expect(on(a, "안녕하세요")).toBe(false);
  });

  it("`exact` still requires the whole message to be the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "exact" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi there")).toBe(false);
  });

  it("ignores empty keywords and empty messages in `word` mode", () => {
    expect(on(automation({ keywords: [""], match_type: "word" }), "anything")).toBe(false);
    expect(on(automation({ keywords: ["hi"], match_type: "word" }), "")).toBe(false);
  });
});

describe("condition steps — IF / ELSE IF / OTHER branch resolution", () => {
  const COND_ID = "cond-1";

  function branchStep(stepId: string, branch: string, value: string) {
    return {
      id: stepId,
      automation_id: "a1",
      step_type: "update_contact_field",
      position: 0,
      parent_step_id: COND_ID,
      branch,
      step_config: { field: "company", value },
    };
  }

  function run(messageText: string) {
    return runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: messageText },
    });
  }

  function companyWrites(): string[] {
    return h.state.updateCalls
      .filter((c) => c.table === "contacts")
      .map((c) => (c.payload as { company: string }).company);
  }

  it("takes the IF branch when the primary predicate matches", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: COND_ID,
        automation_id: "a1",
        step_type: "condition",
        position: 0,
        parent_step_id: null,
        step_config: {
          subject: "message_content",
          value: "hello",
          operator: "contains",
          else_ifs: [
            {
              subject: "message_content",
              value: "urgent",
              operator: "contains",
            },
          ],
        },
      },
      branchStep("b-yes", "yes", "IF_RAN"),
      branchStep("b-else1", "else_if_1", "ELSE_IF_1_RAN"),
      branchStep("b-no", "no", "OTHER_RAN"),
    ];

    await run("HELLO world");

    expect(companyWrites()).toEqual(["IF_RAN"]);
  });

  it("falls to the matching ELSE IF when the primary predicate misses", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: COND_ID,
        automation_id: "a1",
        step_type: "condition",
        position: 0,
        parent_step_id: null,
        step_config: {
          subject: "message_content",
          value: "hello",
          operator: "contains",
          else_ifs: [
            {
              subject: "message_content",
              value: "urgent",
              operator: "contains",
            },
          ],
        },
      },
      branchStep("b-yes", "yes", "IF_RAN"),
      branchStep("b-else1", "else_if_1", "ELSE_IF_1_RAN"),
      branchStep("b-no", "no", "OTHER_RAN"),
    ];

    await run("this is URGENT");

    expect(companyWrites()).toEqual(["ELSE_IF_1_RAN"]);
  });

  it("takes the OTHER (no) branch when nothing matches", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: COND_ID,
        automation_id: "a1",
        step_type: "condition",
        position: 0,
        parent_step_id: null,
        step_config: {
          subject: "message_content",
          value: "hello",
          operator: "contains",
          else_ifs: [
            {
              subject: "message_content",
              value: "urgent",
              operator: "contains",
            },
          ],
        },
      },
      branchStep("b-yes", "yes", "IF_RAN"),
      branchStep("b-else1", "else_if_1", "ELSE_IF_1_RAN"),
      branchStep("b-no", "no", "OTHER_RAN"),
    ];

    await run("completely unrelated");

    expect(companyWrites()).toEqual(["OTHER_RAN"]);
  });

  it("first match wins — a matching ELSE IF is skipped when IF already matched", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: COND_ID,
        automation_id: "a1",
        step_type: "condition",
        position: 0,
        parent_step_id: null,
        step_config: {
          subject: "message_content",
          value: "hello",
          operator: "contains",
          else_ifs: [
            {
              subject: "message_content",
              value: "hello",
              operator: "contains",
            },
          ],
        },
      },
      branchStep("b-yes", "yes", "IF_RAN"),
      branchStep("b-else1", "else_if_1", "ELSE_IF_1_RAN"),
      branchStep("b-no", "no", "OTHER_RAN"),
    ];

    await run("hello hello");

    expect(companyWrites()).toEqual(["IF_RAN"]);
  });

  it("uses the nth branch label for the Nth matching ELSE IF", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: COND_ID,
        automation_id: "a1",
        step_type: "condition",
        position: 0,
        parent_step_id: null,
        step_config: {
          subject: "message_content",
          value: "alpha",
          operator: "contains",
          else_ifs: [
            {
              subject: "message_content",
              value: "beta",
              operator: "contains",
            },
            {
              subject: "message_content",
              value: "gamma",
              operator: "contains",
            },
          ],
        },
      },
      branchStep("b-yes", "yes", "IF_RAN"),
      branchStep("b-else1", "else_if_1", "ELSE_IF_1_RAN"),
      branchStep("b-else2", "else_if_2", "ELSE_IF_2_RAN"),
      branchStep("b-no", "no", "OTHER_RAN"),
    ];

    await run("only GAMMA here");

    expect(companyWrites()).toEqual(["ELSE_IF_2_RAN"]);
  });
});

describe("message_content conditions — match operators", () => {
  it("`contains` matches on a case-insensitive substring", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [{
      id: "cond-1",
      automation_id: "a1",
      step_type: "condition",
      position: 0,
      parent_step_id: null,
      step_config: { subject: "message_content", value: "order", operator: "contains" },
    }];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "Where is my ORDER?" },
    });

    const last = h.state.logUpdates.at(-1) as { steps_executed: AutomationLogStepResult[] };
    expect(last.steps_executed).toContainEqual(
      expect.objectContaining({
        step_type: "condition",
        status: "success",
        detail: "branch=yes",
      }),
    );
  });

  it("`exact_match` matches the whole message case-insensitively", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [{
      id: "cond-1",
      automation_id: "a1",
      step_type: "condition",
      position: 0,
      parent_step_id: null,
      step_config: {
        subject: "message_content",
        value: "order status",
        operator: "exact_match",
        else_ifs: [
          {
            subject: "message_content",
            value: "lost",
            operator: "exact_match",
          },
        ],
      },
    }];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "ORDER STATUS" },
    });

    const last = h.state.logUpdates.at(-1) as { steps_executed: AutomationLogStepResult[] };
    expect(last.steps_executed).toContainEqual(
      expect.objectContaining({
        step_type: "condition",
        status: "success",
        detail: "branch=yes",
      }),
    );
  });

  it("`exact_match` rejects a substring when the whole message differs", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: "cond-1",
        automation_id: "a1",
        step_type: "condition",
        position: 0,
        parent_step_id: null,
        step_config: {
          subject: "message_content",
          value: "order status",
          operator: "exact_match",
        },
      },
      branchStepForOperatorTest("b-no", "no"),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { message_text: "order status please" },
    });

    // The OTHER branch must have run, not the exact-match IF branch.
    const company = h.state.updateCalls
      .filter((c) => c.table === "contacts")
      .map((c) => (c.payload as { company: string }).company);
    expect(company).toEqual(["OTHER_RAN"]);
  });
});

function branchStepForOperatorTest(stepId: string, branch: string) {
  return {
    id: stepId,
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: "cond-1",
    branch,
    step_config: { field: "company", value: "OTHER_RAN" },
  };
}

describe("ELSE branch cooldown — one window per (automation, contact)", () => {
  const COND_ID = "cond-cd";

  /** A message_content condition whose ELSE branch writes a marker. */
  function condition(elseCooldown?: Record<string, unknown>) {
    return {
      id: COND_ID,
      automation_id: "a1",
      step_type: "condition",
      position: 0,
      parent_step_id: null,
      step_config: {
        subject: "message_content",
        value: "hello",
        operator: "contains",
        ...(elseCooldown ? { else_cooldown: elseCooldown } : {}),
      },
    };
  }

  function branchStep(stepId: string, branch: string, value: string) {
    return {
      id: stepId,
      automation_id: "a1",
      step_type: "update_contact_field",
      position: 0,
      parent_step_id: COND_ID,
      branch,
      step_config: { field: "company", value },
    };
  }

  function run(messageText: string, contactId = "c1") {
    return runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId,
      context: { message_text: messageText },
    });
  }

  function companyWrites(): string[] {
    return h.state.updateCalls
      .filter((c) => c.table === "contacts")
      .map((c) => (c.payload as { company: string }).company);
  }

  /** Detail recorded for the condition step of the most recent run. */
  function lastConditionDetail(): string | undefined {
    const updates = h.state.logUpdates;
    const last = updates[updates.length - 1];
    const results = (last?.steps_executed as { detail?: string }[] | undefined) ?? [];
    return results[0]?.detail;
  }

  function setupSteps(elseCooldown?: Record<string, unknown>) {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      condition(elseCooldown),
      branchStep("b-yes", "yes", "IF_RAN"),
      branchStep("b-no", "no", "ELSE_RAN"),
    ];
  }

  it("runs the ELSE branch and claims the window on the first match", async () => {
    setupSteps({ enabled: true, amount: 1, unit: "hours" });

    await run("completely unrelated");

    expect(companyWrites()).toEqual(["ELSE_RAN"]);
    expect(h.state.cooldownCalls).toHaveLength(1);
    expect(h.state.cooldownCalls[0]).toEqual({
      p_automation_id: "a1",
      p_contact_id: "c1",
      p_cooldown_seconds: 3600,
    });
    expect(lastConditionDetail()).toBe("branch=no");
  });

  it("suppresses a repeat ELSE run inside the window", async () => {
    setupSteps({ enabled: true, amount: 1, unit: "hours" });

    await run("first unrelated message");
    h.state.updateCalls = [];
    await run("second unrelated message");

    expect(companyWrites()).toEqual([]);
    expect(lastConditionDetail()).toBe("branch=no (else cooldown active, skipped)");
  });

  it("still runs the IF branch while the ELSE window is open", async () => {
    setupSteps({ enabled: true, amount: 1, unit: "hours" });

    await run("unrelated");
    h.state.updateCalls = [];
    await run("hello again");

    expect(companyWrites()).toEqual(["IF_RAN"]);
    // The IF branch never touches the cooldown.
    expect(h.state.cooldownCalls).toHaveLength(1);
  });

  it("keys the window per contact", async () => {
    setupSteps({ enabled: true, amount: 1, unit: "hours" });

    await run("unrelated", "c1");
    await run("unrelated", "c2");

    expect(companyWrites()).toEqual(["ELSE_RAN", "ELSE_RAN"]);
    expect(h.state.cooldownCalls).toHaveLength(2);
  });

  it("makes no RPC call at all when the cooldown is off (legacy config)", async () => {
    setupSteps();

    await run("unrelated");

    expect(companyWrites()).toEqual(["ELSE_RAN"]);
    expect(h.state.cooldownCalls).toHaveLength(0);
  });

  it("degrades to running the branch when migration 048 is missing", async () => {
    setupSteps({ enabled: true, amount: 1, unit: "hours" });
    h.state.cooldownRpcError = {
      code: "PGRST202",
      message: "Could not find the function public.claim_else_cooldown",
    };

    await run("unrelated");

    expect(companyWrites()).toEqual(["ELSE_RAN"]);
    expect(lastConditionDetail()).toBe("branch=no");
  });

  it("skips the ELSE branch and fails the run when the check itself errors", async () => {
    setupSteps({ enabled: true, amount: 1, unit: "hours" });
    h.state.cooldownRpcError = { code: "XX000", message: "disk full" };

    await run("unrelated");

    expect(companyWrites()).toEqual([]);
    expect(lastConditionDetail()).toBe(
      "else cooldown check failed, skipped branch=no",
    );
    const updates = h.state.logUpdates;
    const last = updates[updates.length - 1];
    expect(last.status).toBe("failed");
    expect(last.error_message).toBe("else cooldown check failed");
  });
});
