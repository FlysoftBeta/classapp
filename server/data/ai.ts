import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  AiConversation,
  AiConversationDetail,
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
       status, reserved_credits)
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
    chargedCredits: number;
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
      `UPDATE ai_runs SET status = ?, error = ?, charged_credits = ?,
       input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
       revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(
      input.status,
      input.error ?? null,
      input.chargedCredits,
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

export function getAiCreditBalance(
  db: Database,
  userId: string,
): AiCreditBalance {
  ensureAccount(db, userId);
  return db
    .prepare(
      "SELECT balance, reserved FROM ai_credit_accounts WHERE user_id = ?",
    )
    .get(userId) as AiCreditBalance;
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
    ensureAccount(db, input.userId);
    const existing = db
      .prepare("SELECT 1 FROM ai_credit_ledger WHERE idempotency_key = ?")
      .get(input.idempotencyKey);
    if (existing) return getAiCreditBalance(db, input.userId);
    db.prepare(
      `UPDATE ai_credit_accounts SET balance = balance + ?,
       updated_at = datetime('now') WHERE user_id = ?`,
    ).run(input.amount, input.userId);
    const balance = getAiCreditBalance(db, input.userId);
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta, balance_after, admin_id, idempotency_key, note)
       VALUES (?, ?, 'top_up', ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      input.userId,
      input.amount,
      balance.balance,
      input.adminId,
      input.idempotencyKey,
      input.note,
    );
    return balance;
  })();
}

export function reserveAiCredits(
  db: Database,
  userId: string,
  runId: string,
  amount: number,
): AiCreditBalance | null {
  return db.transaction(() => {
    ensureAccount(db, userId);
    const account = getAiCreditBalance(db, userId);
    if (account.balance < amount) return null;
    db.prepare(
      `UPDATE ai_credit_accounts SET balance = balance - ?, reserved = reserved + ?,
       updated_at = datetime('now') WHERE user_id = ?`,
    ).run(amount, amount, userId);
    const balance = getAiCreditBalance(db, userId);
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta, balance_after, run_id, idempotency_key, note)
       VALUES (?, ?, 'reserve', ?, ?, ?, ?, 'AI run credit reservation')`,
    ).run(
      crypto.randomUUID(),
      userId,
      -amount,
      balance.balance,
      runId,
      `run:${runId}:reserve`,
    );
    return balance;
  })();
}

export function reserveAiOperationCredits(
  db: Database,
  userId: string,
  operationId: string,
  amount: number,
): AiCreditBalance | null {
  return db.transaction(() => {
    ensureAccount(db, userId);
    const account = getAiCreditBalance(db, userId);
    if (account.balance < amount) return null;
    db.prepare(
      `UPDATE ai_credit_accounts SET balance = balance - ?, reserved = reserved + ?,
       updated_at = datetime('now') WHERE user_id = ?`,
    ).run(amount, amount, userId);
    const balance = getAiCreditBalance(db, userId);
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta, balance_after, idempotency_key, note)
       VALUES (?, ?, 'reserve', ?, ?, ?, 'AI auxiliary operation reservation')`,
    ).run(
      crypto.randomUUID(),
      userId,
      -amount,
      balance.balance,
      `operation:${operationId}:reserve`,
    );
    return balance;
  })();
}

export function settleAiOperationCredits(
  db: Database,
  userId: string,
  operationId: string,
  reserved: number,
  charged: number,
): AiCreditBalance {
  return db.transaction(() => {
    const existing = db
      .prepare("SELECT 1 FROM ai_credit_ledger WHERE idempotency_key = ?")
      .get(`operation:${operationId}:settle`);
    if (existing) return getAiCreditBalance(db, userId);
    const actual = Math.max(0, Math.min(reserved, charged));
    const release = reserved - actual;
    db.prepare(
      `UPDATE ai_credit_accounts SET balance = balance + ?,
       reserved = MAX(0, reserved - ?), updated_at = datetime('now')
       WHERE user_id = ?`,
    ).run(release, reserved, userId);
    const balance = getAiCreditBalance(db, userId);
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta, balance_after, idempotency_key, note)
       VALUES (?, ?, 'settle', 0, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      userId,
      balance.balance,
      `operation:${operationId}:settle`,
      `Charged ${actual} of ${reserved} auxiliary credits`,
    );
    if (release > 0) {
      db.prepare(
        `INSERT INTO ai_credit_ledger
         (id, user_id, kind, delta, balance_after, idempotency_key, note)
         VALUES (?, ?, 'release', ?, ?, ?, 'Unused auxiliary reservation')`,
      ).run(
        crypto.randomUUID(),
        userId,
        release,
        balance.balance,
        `operation:${operationId}:release`,
      );
    }
    return balance;
  })();
}

export function settleAiCredits(
  db: Database,
  userId: string,
  runId: string,
  reserved: number,
  charged: number,
): AiCreditBalance {
  return db.transaction(() => {
    ensureAccount(db, userId);
    const already = db
      .prepare("SELECT 1 FROM ai_credit_ledger WHERE idempotency_key = ?")
      .get(`run:${runId}:settle`);
    if (already) return getAiCreditBalance(db, userId);
    const actual = Math.max(0, Math.min(reserved, charged));
    const release = reserved - actual;
    db.prepare(
      `UPDATE ai_credit_accounts SET balance = balance + ?,
       reserved = MAX(0, reserved - ?), updated_at = datetime('now')
       WHERE user_id = ?`,
    ).run(release, reserved, userId);
    const balance = getAiCreditBalance(db, userId);
    db.prepare(
      `INSERT INTO ai_credit_ledger
       (id, user_id, kind, delta, balance_after, run_id, idempotency_key, note)
       VALUES (?, ?, 'settle', 0, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      userId,
      balance.balance,
      runId,
      `run:${runId}:settle`,
      `Charged ${actual} of ${reserved} reserved credits`,
    );
    if (release > 0) {
      db.prepare(
        `INSERT INTO ai_credit_ledger
         (id, user_id, kind, delta, balance_after, run_id, idempotency_key, note)
         VALUES (?, ?, 'release', ?, ?, ?, ?, 'Unused AI run reservation')`,
      ).run(
        crypto.randomUUID(),
        userId,
        release,
        balance.balance,
        runId,
        `run:${runId}:release`,
      );
    }
    return balance;
  })();
}

export function listAiCreditLedger(
  db: Database,
  userId: string,
  limit = 30,
): AiCreditLedgerEntry[] {
  return db
    .prepare(
      `SELECT id, user_id, kind, delta, balance_after, run_id, admin_id,
        note, created_at FROM ai_credit_ledger WHERE user_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, limit) as AiCreditLedgerEntry[];
}

export function getAiRunBilling(db: Database, runId: string) {
  return db
    .prepare(`SELECT user_id, reserved_credits FROM ai_runs WHERE id = ?`)
    .get(runId) as { user_id: string; reserved_credits: number } | undefined;
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
  reserved_credits: number;
}> {
  return db
    .prepare(
      `SELECT id, user_id, reserved_credits FROM ai_runs
       WHERE status IN ('queued', 'routing', 'running')`,
    )
    .all() as Array<{
    id: string;
    user_id: string;
    reserved_credits: number;
  }>;
}

export function purgeAiUserData(db: Database, userId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM ai_conversations WHERE user_id = ?").run(userId);
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
