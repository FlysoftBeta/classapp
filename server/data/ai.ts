import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  AiConversation,
  AiConversationDetail,
  AiBillingPolicy,
  AiBillingSummary,
  AiCreditBalance,
  AiCreditLedgerEntry,
  AiMessage,
  AiRun,
} from "@/shared/types/api/ai";
import { normalizeAiSearchText } from "@/shared/ai/text";

type ConversationRow = Omit<AiConversation, "unread" | "running"> & {
  unread: number;
  running: number;
};
type RunRow = AiRun;
type MessageRow = Omit<AiMessage, "attachments"> & {
  attachments_json: string;
};

function mapConversation(row: ConversationRow): AiConversation {
  return { ...row, unread: !!row.unread, running: !!row.running };
}

function mapMessage(row: MessageRow): AiMessage {
  const { attachments_json, ...message } = row;
  return {
    ...message,
    attachments: JSON.parse(attachments_json) as AiMessage["attachments"],
  };
}

function ensureAccount(db: Database, userId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO ai_credit_accounts (user_id) VALUES (?)",
  ).run(userId);
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.title,
    (SELECT m.content FROM ai_messages m
      WHERE m.conversation_id = c.id AND m.status = 'completed'
      ORDER BY m.sequence DESC LIMIT 1) AS last_message,
    c.active_leaf_message_id, c.forked_from_conversation_id,
    c.forked_from_message_id,
    (c.last_assistant_sequence > c.last_read_assistant_sequence) AS unread,
    EXISTS(SELECT 1 FROM ai_runs r WHERE r.conversation_id = c.id
      AND r.status IN ('queued', 'routing', 'running')) AS running,
    c.created_at, c.updated_at
  FROM ai_conversations c`;

export function listAiConversations(
  db: Database,
  userId: string,
): AiConversation[] {
  const rows = db
    .prepare(
      `${CONVERSATION_SELECT}
       WHERE c.user_id = ? AND c.archived_at IS NULL
       ORDER BY c.updated_at DESC, c.id DESC`,
    )
    .all(userId) as ConversationRow[];
  return rows.map(mapConversation);
}

export function searchAiConversations(
  db: Database,
  userId: string,
  rawQuery: string,
  normalizedTags: string[],
): AiConversation[] {
  const query = normalizeAiSearchText(rawQuery);
  if (!query) return listAiConversations(db, userId);
  const tags = [...new Set(normalizedTags)].filter(Boolean).slice(0, 40);
  const placeholders = tags.map(() => "?").join(", ");
  const tagClause = tags.length
    ? `OR EXISTS (SELECT 1 FROM ai_conversation_tags t
         WHERE t.conversation_id = c.id AND t.normalized_tag IN (${placeholders}))`
    : "";
  const rows = db
    .prepare(
      `${CONVERSATION_SELECT}
       WHERE c.user_id = ? AND c.archived_at IS NULL
         AND (instr(c.title_norm, ?) > 0 ${tagClause})
       ORDER BY
         CASE WHEN c.title_norm = ? THEN 0
              WHEN c.title_norm LIKE ? THEN 1
              WHEN instr(c.title_norm, ?) > 0 THEN 2
              ELSE 3 END,
         c.updated_at DESC`,
    )
    .all(
      userId,
      query,
      ...tags,
      query,
      `${query}%`,
      query,
    ) as ConversationRow[];
  return rows.map(mapConversation);
}

export function getAiConversation(
  db: Database,
  userId: string,
  conversationId: string,
): AiConversation | null {
  const row = db
    .prepare(
      `${CONVERSATION_SELECT}
       WHERE c.id = ? AND c.user_id = ? AND c.archived_at IS NULL`,
    )
    .get(conversationId, userId) as ConversationRow | undefined;
  return row ? mapConversation(row) : null;
}

export function getAiMessage(
  db: Database,
  userId: string,
  messageId: string,
): AiMessage | null {
  const row = db
    .prepare(
      `SELECT m.id, m.conversation_id, m.parent_message_id, m.role,
        m.content, m.attachments_json, m.status, m.sequence, m.run_id,
        m.created_at, m.updated_at
       FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
       WHERE m.id = ? AND c.user_id = ?`,
    )
    .get(messageId, userId) as MessageRow | undefined;
  return row ? mapMessage(row) : null;
}

export function getAiConversationDetail(
  db: Database,
  userId: string,
  conversationId: string,
): AiConversationDetail | null {
  const conversation = getAiConversation(db, userId, conversationId);
  if (!conversation) return null;
  const messages = db
    .prepare(
      `SELECT id, conversation_id, parent_message_id, role, content,
        attachments_json, status, sequence, run_id, created_at, updated_at
       FROM ai_messages WHERE conversation_id = ? ORDER BY sequence`,
    )
    .all(conversationId) as MessageRow[];
  const activeRun = db
    .prepare(
      `SELECT id, conversation_id, input_message_id, output_message_id,
        status, revision, error, created_at, updated_at
       FROM ai_runs WHERE conversation_id = ?
         AND status IN ('queued', 'routing', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(conversationId) as RunRow | undefined;
  return {
    conversation,
    messages: messages.map(mapMessage),
    active_run: activeRun ?? null,
  };
}

export function createAiConversation(
  db: Database,
  input: {
    id: string;
    userId: string;
    title: string;
    forkedFromConversationId?: string | null;
    forkedFromMessageId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO ai_conversations
      (id, user_id, title, title_norm, forked_from_conversation_id,
       forked_from_message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.title,
    normalizeAiSearchText(input.title),
    input.forkedFromConversationId ?? null,
    input.forkedFromMessageId ?? null,
  );
}

export function createAiRunRecords(
  db: Database,
  input: {
    runId: string;
    conversationId: string;
    userId: string;
    parentMessageId: string | null;
    userMessageId: string;
    assistantMessageId: string;
    content: string;
    attachments: AiMessage["attachments"];
    reservedCredits: number;
  },
): void {
  db.prepare(
    `INSERT INTO ai_messages
      (id, conversation_id, parent_message_id, role, content,
       attachments_json, status)
     VALUES (?, ?, ?, 'user', ?, ?, 'completed')`,
  ).run(
    input.userMessageId,
    input.conversationId,
    input.parentMessageId,
    input.content,
    JSON.stringify(input.attachments),
  );
  db.prepare(
    `INSERT INTO ai_messages
      (id, conversation_id, parent_message_id, role, content, status, run_id)
     VALUES (?, ?, ?, 'assistant', '', 'pending', ?)`,
  ).run(
    input.assistantMessageId,
    input.conversationId,
    input.userMessageId,
    input.runId,
  );
  db.prepare(
    `INSERT INTO ai_runs
      (id, user_id, conversation_id, input_message_id, output_message_id,
       status, reserved_credit_micros)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    input.runId,
    input.userId,
    input.conversationId,
    input.userMessageId,
    input.assistantMessageId,
    input.reservedCredits,
  );
  db.prepare(
    `UPDATE ai_conversations SET active_leaf_message_id = ?,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(input.assistantMessageId, input.conversationId);
}

export function moveAiRunToConversation(
  db: Database,
  input: {
    runId: string;
    oldConversationId: string;
    newConversationId: string;
    oldActiveLeafMessageId: string | null;
  },
): void {
  db.transaction(() => {
    const run = db
      .prepare(
        "SELECT input_message_id, output_message_id FROM ai_runs WHERE id = ?",
      )
      .get(input.runId) as {
      input_message_id: string;
      output_message_id: string;
    };
    db.prepare(
      `UPDATE ai_messages SET conversation_id = ?, parent_message_id = NULL
       WHERE id = ?`,
    ).run(input.newConversationId, run.input_message_id);
    db.prepare("UPDATE ai_messages SET conversation_id = ? WHERE id = ?").run(
      input.newConversationId,
      run.output_message_id,
    );
    db.prepare("UPDATE ai_runs SET conversation_id = ? WHERE id = ?").run(
      input.newConversationId,
      input.runId,
    );
    db.prepare(
      `UPDATE ai_conversations SET active_leaf_message_id = ?,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(input.oldActiveLeafMessageId, input.oldConversationId);
    db.prepare(
      `UPDATE ai_conversations SET active_leaf_message_id = ?,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(run.output_message_id, input.newConversationId);
  })();
}

export function listAiBranchMessages(
  db: Database,
  userId: string,
  conversationId: string,
  leafMessageId?: string | null,
): AiMessage[] {
  const conversation = db
    .prepare(
      `SELECT active_leaf_message_id, forked_from_message_id
       FROM ai_conversations WHERE id = ? AND user_id = ?`,
    )
    .get(conversationId, userId) as
    | {
        active_leaf_message_id: string | null;
        forked_from_message_id: string | null;
      }
    | undefined;
  if (!conversation) return [];
  const leaf = leafMessageId ?? conversation.active_leaf_message_id;
  const ancestry = (messageId: string | null): AiMessage[] => {
    if (!messageId) return [];
    const rows = db
      .prepare(
        `WITH RECURSIVE ancestry AS (
           SELECT id, conversation_id, parent_message_id, role, content,
             attachments_json, status, sequence, run_id, created_at, updated_at
           FROM ai_messages WHERE id = ?
           UNION ALL
           SELECT m.id, m.conversation_id, m.parent_message_id, m.role,
             m.content, m.attachments_json, m.status, m.sequence, m.run_id,
             m.created_at, m.updated_at
           FROM ai_messages m JOIN ancestry a ON a.parent_message_id = m.id
         )
         SELECT * FROM ancestry ORDER BY sequence`,
      )
      .all(messageId) as MessageRow[];
    return rows.map(mapMessage);
  };
  const local = ancestry(leaf).filter(
    (message) => message.status === "completed",
  );
  if (!conversation.forked_from_message_id) return local;
  const origin = ancestry(conversation.forked_from_message_id).filter(
    (message) => message.status === "completed",
  );
  const ids = new Set(origin.map((message) => message.id));
  return [...origin, ...local.filter((message) => !ids.has(message.id))];
}

export function latestAiContextSnapshot(
  db: Database,
  conversationId: string,
): { through_message_id: string; summary_json: string } | null {
  return (
    (db
      .prepare(
        `SELECT through_message_id, summary_json FROM ai_context_snapshots
         WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(conversationId) as
      { through_message_id: string; summary_json: string } | undefined) ?? null
  );
}

export function saveAiContextSnapshot(
  db: Database,
  input: {
    id: string;
    conversationId: string;
    throughMessageId: string;
    summary: unknown;
    promptVersion: number;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO ai_context_snapshots
     (id, conversation_id, through_message_id, summary_json, prompt_version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.conversationId,
    input.throughMessageId,
    JSON.stringify(input.summary),
    input.promptVersion,
  );
}

export function updateAiRunRouting(
  db: Database,
  runId: string,
  input: {
    status: "routing" | "running";
    placeholder?: string;
    providerModel?: string;
    reasoningEffort?: string;
  },
): void {
  db.prepare(
    `UPDATE ai_runs SET status = ?, model_placeholder = COALESCE(?, model_placeholder),
       provider_model = COALESCE(?, provider_model),
       reasoning_effort = COALESCE(?, reasoning_effort), revision = revision + 1,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(
    input.status,
    input.placeholder ?? null,
    input.providerModel ?? null,
    input.reasoningEffort ?? null,
    runId,
  );
}

export function updateAiRunStream(
  db: Database,
  runId: string,
  content: string,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE ai_messages SET content = ?, status = 'streaming',
       updated_at = datetime('now') WHERE run_id = ? AND role = 'assistant'`,
    ).run(content, runId);
    db.prepare(
      `UPDATE ai_runs SET status = 'running', revision = revision + 1,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(runId);
  })();
}

export function finishAiRun(
  db: Database,
  runId: string,
  input: {
    status: "completed" | "failed" | "cancelled";
    content: string;
    error?: string | null;
    chargedCreditMicros: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  },
): void {
  db.transaction(() => {
    const run = db
      .prepare("SELECT conversation_id FROM ai_runs WHERE id = ?")
      .get(runId) as { conversation_id: string } | undefined;
    if (!run) return;
    db.prepare(
      `UPDATE ai_messages SET content = ?, status = ?, updated_at = datetime('now')
       WHERE run_id = ? AND role = 'assistant'`,
    ).run(input.content, input.status, runId);
    db.prepare(
      `UPDATE ai_runs SET status = ?, error = ?, charged_credit_micros = ?,
       input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
       revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(
      input.status,
      input.error ?? null,
      input.chargedCreditMicros,
      input.inputTokens,
      input.cachedInputTokens,
      input.outputTokens,
      runId,
    );
    if (input.status === "completed") {
      const message = db
        .prepare("SELECT sequence FROM ai_messages WHERE run_id = ?")
        .get(runId) as { sequence: number };
      db.prepare(
        `UPDATE ai_conversations SET last_assistant_sequence = ?,
         updated_at = datetime('now') WHERE id = ?`,
      ).run(message.sequence, run.conversation_id);
    } else {
      db.prepare(
        "UPDATE ai_conversations SET updated_at = datetime('now') WHERE id = ?",
      ).run(run.conversation_id);
    }
  })();
}

/**
 * Terminal run state and its credit reservation move together. Keeping them in
 * one transaction removes the crash window that left a completed/failed run
 * with an active reservation forever.
 */
export function finishAndSettleAiRun(
  db: Database,
  runId: string,
  input: {
    status: "completed" | "failed" | "cancelled";
    content: string;
    error?: string | null;
    chargedCreditMicros: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  },
): void {
  db.transaction(() => {
    const run = db
      .prepare("SELECT user_id FROM ai_runs WHERE id = ?")
      .get(runId) as { user_id: string } | undefined;
    if (!run) return;
    finishAiRun(db, runId, input);
    settleCredits(
      db,
      run.user_id,
      `run:${runId}`,
      runId,
      input.chargedCreditMicros,
    );
  })();
}

/** Repair terminal runs whose reservation was never settled before a crash. */
export function settleTerminalAiReservations(db: Database): number {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT r.id, r.user_id, r.charged_credit_micros
           FROM ai_credit_reservations res
           JOIN ai_runs r ON r.id = res.run_id
          WHERE res.status = 'active'
            AND r.status IN ('completed', 'failed', 'cancelled')`,
      )
      .all() as Array<{
      id: string;
      user_id: string;
      charged_credit_micros: number;
    }>;
    for (const row of rows) {
      settleCredits(
        db,
        row.user_id,
        `run:${row.id}`,
        row.id,
        row.charged_credit_micros,
      );
    }
    return rows.length;
  })();
}

export function getAiRun(
  db: Database,
  userId: string,
  runId: string,
): AiRun | null {
  return (
    (db
      .prepare(
        `SELECT id, conversation_id, input_message_id, output_message_id,
          status, revision, error, created_at, updated_at
         FROM ai_runs WHERE id = ? AND user_id = ?`,
      )
      .get(runId, userId) as AiRun | undefined) ?? null
  );
}

export function requestAiRunCancellation(
  db: Database,
  userId: string,
  runId: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE ai_runs SET cancel_requested = 1, revision = revision + 1,
         updated_at = datetime('now') WHERE id = ? AND user_id = ?
         AND status IN ('queued', 'routing', 'running')`,
      )
      .run(runId, userId).changes > 0
  );
}

export function isAiRunCancellationRequested(
  db: Database,
  runId: string,
): boolean {
  const row = db
    .prepare("SELECT cancel_requested FROM ai_runs WHERE id = ?")
    .get(runId) as { cancel_requested: number } | undefined;
  return !!row?.cancel_requested;
}

export function markAiConversationRead(
  db: Database,
  userId: string,
  conversationId: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE ai_conversations
         SET last_read_assistant_sequence = last_assistant_sequence
         WHERE id = ? AND user_id = ?`,
      )
      .run(conversationId, userId).changes > 0
  );
}

export function updateAiConversationMetadata(
  db: Database,
  userId: string,
  conversationId: string,
  title: string,
  tags: Array<{ normalized: string; display: string }>,
  promptVersion: number,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE ai_conversations SET title = ?, title_norm = ?,
       updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
    ).run(title, normalizeAiSearchText(title), conversationId, userId);
    db.prepare(
      "DELETE FROM ai_conversation_tags WHERE conversation_id = ?",
    ).run(conversationId);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ai_conversation_tags
       (conversation_id, normalized_tag, display_tag, prompt_version)
       VALUES (?, ?, ?, ?)`,
    );
    for (const tag of tags.slice(0, 40)) {
      insert.run(conversationId, tag.normalized, tag.display, promptVersion);
    }
  })();
}

export const CREDIT_MICRO_SCALE = 1_000_000;

export function creditsFromMicros(value: number): number {
  return Number((value / CREDIT_MICRO_SCALE).toFixed(6));
}

export function microsFromCredits(value: number): number {
  return Math.round(value * CREDIT_MICRO_SCALE);
}

interface BillingPolicyRow {
  daily_credit_micros: number;
  weekly_credit_micros: number;
  default_plan_duration_days: number;
  updated_at: string;
}

interface AccountRow {
  top_up_credit_micros: number;
  reserved_credit_micros: number;
}

interface EnrollmentRow {
  starts_at: string;
  ends_at: string;
}

export function aiAccountingWindow(now = new Date()): {
  day: string;
  week: string;
} {
  const day = now.toISOString().slice(0, 10);
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const weekday = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - weekday + 1);
  return { day, week: monday.toISOString().slice(0, 10) };
}

function billingPolicyRow(db: Database): BillingPolicyRow {
  return db
    .prepare(
      `SELECT daily_credit_micros, weekly_credit_micros,
      default_plan_duration_days, updated_at
     FROM ai_billing_policy WHERE id = 1`,
    )
    .get() as BillingPolicyRow;
}

function ensureBillingState(db: Database, userId: string): void {
  ensureAccount(db, userId);
  const policy = billingPolicyRow(db);
  db.prepare(
    `INSERT OR IGNORE INTO ai_plan_enrollments (user_id, starts_at, ends_at)
     VALUES (?, datetime('now'), datetime('now', '+' || ? || ' days'))`,
  ).run(userId, policy.default_plan_duration_days);
}

function quotaUsage(
  db: Database,
  userId: string,
  keys: { day: string; week: string },
): { daily: number; weekly: number } {
  const daily = db
    .prepare(
      `SELECT COALESCE(SUM(plan_credit_micros), 0) AS value
     FROM ai_credit_usage WHERE user_id = ? AND day_key = ?`,
    )
    .get(userId, keys.day) as { value: number };
  const weekly = db
    .prepare(
      `SELECT COALESCE(SUM(plan_credit_micros), 0) AS value
     FROM ai_credit_usage WHERE user_id = ? AND week_key = ?`,
    )
    .get(userId, keys.week) as { value: number };
  return { daily: daily.value, weekly: weekly.value };
}

function percent(used: number, allowance: number): number {
  if (allowance === 0) return used > 0 ? 100 : 0;
  return Math.min(100, Number(((used / allowance) * 100).toFixed(2)));
}

export function getAiCreditBalance(
  db: Database,
  userId: string,
): AiCreditBalance {
  ensureBillingState(db, userId);
  const account = db
    .prepare(
      `SELECT top_up_credit_micros, reserved_credit_micros
     FROM ai_credit_accounts WHERE user_id = ?`,
    )
    .get(userId) as AccountRow;
  const policy = billingPolicyRow(db);
  const enrollment = db
    .prepare(
      `SELECT starts_at, ends_at FROM ai_plan_enrollments WHERE user_id = ?`,
    )
    .get(userId) as EnrollmentRow;
  const active = db
    .prepare(`SELECT (? <= datetime('now') AND datetime('now') < ?) AS value`)
    .get(enrollment.starts_at, enrollment.ends_at) as { value: number };
  const usage = quotaUsage(db, userId, aiAccountingWindow());
  const dailyAllowance = active.value ? policy.daily_credit_micros : 0;
  const weeklyAllowance = active.value ? policy.weekly_credit_micros : 0;
  const dailyRemaining = Math.max(0, dailyAllowance - usage.daily);
  const weeklyRemaining = Math.max(0, weeklyAllowance - usage.weekly);
  const available = Math.max(
    0,
    Math.min(dailyRemaining, weeklyRemaining) +
      account.top_up_credit_micros -
      account.reserved_credit_micros,
  );
  const window = (allowance: number, used: number) => ({
    allowance: creditsFromMicros(allowance),
    used: creditsFromMicros(used),
    remaining: creditsFromMicros(Math.max(0, allowance - used)),
    used_percent: percent(used, allowance),
  });
  return {
    available: creditsFromMicros(available),
    reserved: creditsFromMicros(account.reserved_credit_micros),
    top_up: creditsFromMicros(account.top_up_credit_micros),
    plan: {
      active: !!active.value,
      starts_at: enrollment.starts_at,
      ends_at: enrollment.ends_at,
      daily: window(dailyAllowance, usage.daily),
      weekly: window(weeklyAllowance, usage.weekly),
    },
  };
}

export function topUpAiCredits(
  db: Database,
  input: {
    userId: string;
    adminId: string;
    amount: number;
    idempotencyKey: string;
    note: string;
  },
): AiCreditBalance {
  return db.transaction(() => {
    ensureBillingState(db, input.userId);
    const existing = db
      .prepare("SELECT 1 FROM ai_credit_ledger WHERE idempotency_key = ?")
      .get(input.idempotencyKey);
    if (existing) return getAiCreditBalance(db, input.userId);
    const amount = microsFromCredits(input.amount);
    db.prepare(
      `UPDATE ai_credit_accounts
       SET top_up_credit_micros = top_up_credit_micros + ?,
         updated_at = datetime('now') WHERE user_id = ?`,
    ).run(amount, input.userId);
    const account = db
      .prepare(
        "SELECT top_up_credit_micros AS value FROM ai_credit_accounts WHERE user_id = ?",
      )
      .get(input.userId) as { value: number };
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta_credit_micros, top_up_after_credit_micros,
        admin_id, idempotency_key, note)
       VALUES (?, ?, 'top_up', ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      input.userId,
      amount,
      account.value,
      input.adminId,
      input.idempotencyKey,
      input.note,
    );
    return getAiCreditBalance(db, input.userId);
  })();
}

function reserveCredits(
  db: Database,
  userId: string,
  operationId: string,
  runId: string | null,
  amountCreditMicros: number,
): AiCreditBalance | null {
  return db.transaction(() => {
    ensureBillingState(db, userId);
    const existing = db
      .prepare(
        "SELECT status FROM ai_credit_reservations WHERE operation_id = ?",
      )
      .get(operationId) as { status: string } | undefined;
    if (existing) return getAiCreditBalance(db, userId);
    const available = microsFromCredits(
      getAiCreditBalance(db, userId).available,
    );
    if (available < amountCreditMicros) return null;
    db.prepare(
      `INSERT INTO ai_credit_reservations
       (operation_id, user_id, run_id, amount_credit_micros, status)
       VALUES (?, ?, ?, ?, 'active')`,
    ).run(operationId, userId, runId, amountCreditMicros);
    db.prepare(
      `UPDATE ai_credit_accounts
       SET reserved_credit_micros = reserved_credit_micros + ?,
         updated_at = datetime('now') WHERE user_id = ?`,
    ).run(amountCreditMicros, userId);
    const topUp = db
      .prepare(
        "SELECT top_up_credit_micros AS value FROM ai_credit_accounts WHERE user_id = ?",
      )
      .get(userId) as { value: number };
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta_credit_micros, top_up_after_credit_micros,
        run_id, idempotency_key, note)
       VALUES (?, ?, 'reserve', 0, ?, ?, ?, 'AI credit reservation')`,
    ).run(
      crypto.randomUUID(),
      userId,
      topUp.value,
      runId,
      `${operationId}:reserve`,
    );
    return getAiCreditBalance(db, userId);
  })();
}

export function reserveAiCredits(
  db: Database,
  userId: string,
  runId: string,
  amountCreditMicros: number,
): AiCreditBalance | null {
  return reserveCredits(db, userId, `run:${runId}`, runId, amountCreditMicros);
}

export function reserveAiOperationCredits(
  db: Database,
  userId: string,
  operationId: string,
  amountCreditMicros: number,
): AiCreditBalance | null {
  return reserveCredits(
    db,
    userId,
    `operation:${operationId}`,
    null,
    amountCreditMicros,
  );
}

function settleCredits(
  db: Database,
  userId: string,
  operationId: string,
  runId: string | null,
  chargedCreditMicros: number,
): AiCreditBalance {
  return db.transaction(() => {
    ensureBillingState(db, userId);
    const reservation = db
      .prepare(
        `SELECT amount_credit_micros, status FROM ai_credit_reservations
       WHERE operation_id = ? AND user_id = ?`,
      )
      .get(operationId, userId) as
      { amount_credit_micros: number; status: string } | undefined;
    if (!reservation || reservation.status !== "active") {
      return getAiCreditBalance(db, userId);
    }
    const actual = Math.max(
      0,
      Math.min(
        reservation.amount_credit_micros,
        Math.round(chargedCreditMicros),
      ),
    );
    const policy = billingPolicyRow(db);
    const keys = aiAccountingWindow();
    const usage = quotaUsage(db, userId, keys);
    const enrollment = db
      .prepare(
        `SELECT (starts_at <= datetime('now') AND datetime('now') < ends_at) AS active
       FROM ai_plan_enrollments WHERE user_id = ?`,
      )
      .get(userId) as { active: number };
    const planAvailable = enrollment.active
      ? Math.max(
          0,
          Math.min(
            policy.daily_credit_micros - usage.daily,
            policy.weekly_credit_micros - usage.weekly,
          ),
        )
      : 0;
    const planCharge = Math.min(actual, planAvailable);
    const topUpCharge = actual - planCharge;
    const account = db
      .prepare(
        `SELECT top_up_credit_micros FROM ai_credit_accounts WHERE user_id = ?`,
      )
      .get(userId) as { top_up_credit_micros: number };
    const collectibleTopUp = Math.min(
      topUpCharge,
      account.top_up_credit_micros,
    );
    const collected = planCharge + collectibleTopUp;
    db.prepare(
      `UPDATE ai_credit_accounts SET
        top_up_credit_micros = top_up_credit_micros - ?,
        reserved_credit_micros = MAX(0, reserved_credit_micros - ?),
        updated_at = datetime('now') WHERE user_id = ?`,
    ).run(collectibleTopUp, reservation.amount_credit_micros, userId);
    db.prepare(
      `UPDATE ai_credit_reservations SET status = 'settled',
       updated_at = datetime('now') WHERE operation_id = ?`,
    ).run(operationId);
    db.prepare(
      `INSERT INTO ai_credit_usage
       (id, operation_id, user_id, run_id, day_key, week_key,
        charged_credit_micros, plan_credit_micros, top_up_credit_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      operationId,
      userId,
      runId,
      keys.day,
      keys.week,
      collected,
      planCharge,
      collectibleTopUp,
    );
    const topUpAfter = account.top_up_credit_micros - collectibleTopUp;
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta_credit_micros, top_up_after_credit_micros,
        run_id, idempotency_key, note)
       VALUES (?, ?, 'settle', ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      userId,
      -collectibleTopUp,
      topUpAfter,
      runId,
      `${operationId}:settle`,
      `Charged ${creditsFromMicros(collected)} credits`,
    );
    if (actual < reservation.amount_credit_micros) {
      db.prepare(
        `INSERT INTO ai_credit_ledger
         (id, user_id, kind, delta_credit_micros, top_up_after_credit_micros,
          run_id, idempotency_key, note)
         VALUES (?, ?, 'release', 0, ?, ?, ?, 'Unused reservation released')`,
      ).run(
        crypto.randomUUID(),
        userId,
        topUpAfter,
        runId,
        `${operationId}:release`,
      );
    }
    return getAiCreditBalance(db, userId);
  })();
}

export function settleAiOperationCredits(
  db: Database,
  userId: string,
  operationId: string,
  _reservedCreditMicros: number,
  chargedCreditMicros: number,
): AiCreditBalance {
  return settleCredits(
    db,
    userId,
    `operation:${operationId}`,
    null,
    chargedCreditMicros,
  );
}

export function settleAiCredits(
  db: Database,
  userId: string,
  runId: string,
  _reservedCreditMicros: number,
  chargedCreditMicros: number,
): AiCreditBalance {
  return settleCredits(db, userId, `run:${runId}`, runId, chargedCreditMicros);
}

export function listAiCreditLedger(
  db: Database,
  userId: string,
  limit = 30,
): AiCreditLedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT id, user_id, kind, delta_credit_micros,
        top_up_after_credit_micros, run_id, admin_id,
        note, created_at FROM ai_credit_ledger WHERE user_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<
    Omit<AiCreditLedgerEntry, "delta" | "top_up_after"> & {
      delta_credit_micros: number;
      top_up_after_credit_micros: number;
    }
  >;
  return rows.map(
    ({ delta_credit_micros, top_up_after_credit_micros, ...row }) => ({
      ...row,
      delta: creditsFromMicros(delta_credit_micros),
      top_up_after: creditsFromMicros(top_up_after_credit_micros),
    }),
  );
}

export function getAiBillingPolicy(db: Database): AiBillingPolicy {
  const row = billingPolicyRow(db);
  return {
    daily_allowance: creditsFromMicros(row.daily_credit_micros),
    weekly_allowance: creditsFromMicros(row.weekly_credit_micros),
    default_plan_duration_days: row.default_plan_duration_days,
    updated_at: row.updated_at,
  };
}

export function updateAiBillingPolicy(
  db: Database,
  input: {
    dailyAllowance: number;
    weeklyAllowance: number;
    defaultPlanDurationDays: number;
    adminId: string;
  },
): AiBillingPolicy {
  const daily = microsFromCredits(input.dailyAllowance);
  const weekly = microsFromCredits(input.weeklyAllowance);
  db.prepare(
    `UPDATE ai_billing_policy SET daily_credit_micros = ?,
      weekly_credit_micros = ?, default_plan_duration_days = ?,
      updated_by = ?, updated_at = datetime('now') WHERE id = 1`,
  ).run(daily, weekly, input.defaultPlanDurationDays, input.adminId);
  return getAiBillingPolicy(db);
}

export function assignAiPlan(
  db: Database,
  input: { userId: string; durationDays: number; adminId: string },
): AiCreditBalance {
  ensureAccount(db, input.userId);
  db.prepare(
    `INSERT INTO ai_plan_enrollments
      (user_id, starts_at, ends_at, assigned_by, updated_at)
     VALUES (?, datetime('now'), datetime('now', '+' || ? || ' days'), ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET starts_at = excluded.starts_at,
       ends_at = excluded.ends_at, assigned_by = excluded.assigned_by,
       updated_at = excluded.updated_at`,
  ).run(input.userId, input.durationDays, input.adminId);
  return getAiCreditBalance(db, input.userId);
}

export function getAiBillingSummary(db: Database): AiBillingSummary {
  const policy = billingPolicyRow(db);
  const activePlans = db
    .prepare(
      `SELECT COUNT(*) AS value FROM ai_plan_enrollments
     WHERE starts_at <= datetime('now') AND datetime('now') < ends_at`,
    )
    .get() as { value: number };
  const topUp = db
    .prepare(
      `SELECT COALESCE(SUM(top_up_credit_micros), 0) AS value
     FROM ai_credit_accounts`,
    )
    .get() as { value: number };
  const consumption = db
    .prepare(
      `SELECT day_key AS date, SUM(charged_credit_micros) AS value
     FROM ai_credit_usage
     WHERE day_key >= date('now', '-29 days')
     GROUP BY day_key ORDER BY day_key`,
    )
    .all() as Array<{ date: string; value: number }>;
  const weeklyPlan = activePlans.value * policy.weekly_credit_micros;
  return {
    policy: getAiBillingPolicy(db),
    stock: {
      weekly_plan: creditsFromMicros(weeklyPlan),
      top_up: creditsFromMicros(topUp.value),
      total: creditsFromMicros(weeklyPlan + topUp.value),
    },
    consumption_by_day: consumption.map((item) => ({
      date: item.date,
      credits: creditsFromMicros(item.value),
    })),
  };
}

export function getAiRunBilling(db: Database, runId: string) {
  return db
    .prepare(`SELECT user_id, reserved_credit_micros FROM ai_runs WHERE id = ?`)
    .get(runId) as
    { user_id: string; reserved_credit_micros: number } | undefined;
}

export function getAiFileOperation(
  db: Database,
  userId: string,
  callId: string,
): {
  status: string;
  result_json: string | null;
  error: string | null;
  after_revision: number;
} | null {
  return (
    (db
      .prepare(
        `SELECT status, result_json, error, after_revision FROM ai_file_operations
         WHERE user_id = ? AND call_id = ?`,
      )
      .get(userId, callId) as
      | {
          status: string;
          result_json: string | null;
          error: string | null;
          after_revision: number;
        }
      | undefined) ?? null
  );
}

export function listInterruptedAiRuns(db: Database): Array<{
  id: string;
  user_id: string;
  reserved_credit_micros: number;
}> {
  return db
    .prepare(
      `SELECT id, user_id, reserved_credit_micros FROM ai_runs
       WHERE status IN ('queued', 'routing', 'running')`,
    )
    .all() as Array<{
    id: string;
    user_id: string;
    reserved_credit_micros: number;
  }>;
}

export function purgeAiConversationData(db: Database, userId: string): void {
  db.prepare("DELETE FROM ai_conversations WHERE user_id = ?").run(userId);
}

export function purgeAiBillingData(db: Database, userId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM ai_credit_reservations WHERE user_id = ?").run(
      userId,
    );
    db.prepare("DELETE FROM ai_credit_usage WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM ai_credit_ledger WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM ai_plan_enrollments WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM ai_credit_accounts WHERE user_id = ?").run(userId);
  })();
}

export function planAiFileOperation(
  db: Database,
  input: {
    id: string;
    userId: string;
    runId: string;
    callId: string;
    beforeRevision: number;
    afterRevision: number;
  },
): void {
  db.prepare(
    `INSERT INTO ai_file_operations
     (id, user_id, run_id, call_id, before_revision, after_revision, status)
     VALUES (?, ?, ?, ?, ?, ?, 'planned')`,
  ).run(
    input.id,
    input.userId,
    input.runId,
    input.callId,
    input.beforeRevision,
    input.afterRevision,
  );
}

export function finishAiFileOperation(
  db: Database,
  userId: string,
  callId: string,
  result: unknown,
  error?: string,
): void {
  db.prepare(
    `UPDATE ai_file_operations SET status = ?, result_json = ?, error = ?,
     updated_at = datetime('now') WHERE user_id = ? AND call_id = ?`,
  ).run(
    error ? "failed" : "committed",
    error ? null : JSON.stringify(result),
    error ?? null,
    userId,
    callId,
  );
}
