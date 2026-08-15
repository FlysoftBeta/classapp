import type { Database } from "better-sqlite3";
import {
  finishAiRun,
  getAiRunBilling,
  listInterruptedAiRuns,
  settleAiCredits,
} from "@/server/data/ai";

/** Process-bound ownership of active AI executions and restart reconciliation. */
export class AiExecutionRuntime {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly db: Database) {
    for (const run of listInterruptedAiRuns(db)) {
      finishAiRun(db, run.id, {
        status: "failed",
        content: "服务重启中断了本次生成，请重新发送。",
        error: "AI run interrupted by server restart",
        chargedCreditMicros: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
      settleAiCredits(db, run.user_id, run.id, run.reserved_credit_micros, 0);
    }
  }

  begin(runId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  finish(runId: string): void {
    this.controllers.delete(runId);
  }

  abort(runId: string): void {
    this.controllers.get(runId)?.abort();
  }

  abortUser(userId: string): void {
    for (const [runId, controller] of this.controllers) {
      if (getAiRunBilling(this.db, runId)?.user_id === userId) {
        controller.abort();
      }
    }
  }
}
