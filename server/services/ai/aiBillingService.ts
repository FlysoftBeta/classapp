import type { Database } from "better-sqlite3";
import {
  assignAiPlan,
  creditsFromMicros,
  getAiBillingSummary,
  getAiCreditBalance,
  getAiRunBilling,
  listAiCreditLedger,
  purgeAiBillingData,
  reserveAiCredits,
  reserveAiOperationCredits,
  settleAiCredits,
  settleAiOperationCredits,
  topUpAiCredits,
  updateAiBillingPolicy,
} from "@/server/data/ai";
import { userExists } from "@/server/data/users";
import { PublicError } from "@/server/services/incidentService";

/** Plans, quota windows, reservations, settlement, top-ups, and aggregation. */
export class AiBillingService {
  constructor(private readonly db: Database) {}

  balance(userId: string) {
    return getAiCreditBalance(this.db, userId);
  }

  quoteReservation(userId: string, creditMicros: number) {
    const available = this.balance(userId).available;
    const required = creditsFromMicros(creditMicros);
    return { sufficient: available >= required, available, required };
  }

  account(userId: string) {
    this.requireUser(userId);
    return {
      credits: this.balance(userId),
      ledger: listAiCreditLedger(this.db, userId),
    };
  }

  topUp(input: {
    userId: string;
    adminId: string;
    amount: number;
    idempotencyKey: string;
    note: string;
  }) {
    this.requireUser(input.userId);
    return topUpAiCredits(this.db, input);
  }

  summary() {
    return getAiBillingSummary(this.db);
  }

  updatePolicy(input: {
    dailyAllowance: number;
    weeklyAllowance: number;
    defaultPlanDurationDays: number;
    adminId: string;
  }) {
    return updateAiBillingPolicy(this.db, input);
  }

  assignPlan(input: { userId: string; durationDays: number; adminId: string }) {
    this.requireUser(input.userId);
    return assignAiPlan(this.db, input);
  }

  reserveRun(userId: string, runId: string, creditMicros: number) {
    return reserveAiCredits(this.db, userId, runId, creditMicros);
  }

  reserveOperation(userId: string, operationId: string, creditMicros: number) {
    return reserveAiOperationCredits(
      this.db,
      userId,
      operationId,
      creditMicros,
    );
  }

  settleRun(userId: string, runId: string, chargedCreditMicros: number): void {
    settleAiCredits(this.db, userId, runId, 0, chargedCreditMicros);
  }

  settleOperation(
    userId: string,
    operationId: string,
    chargedCreditMicros: number,
  ): void {
    settleAiOperationCredits(
      this.db,
      userId,
      operationId,
      0,
      chargedCreditMicros,
    );
  }

  runReservation(runId: string) {
    return getAiRunBilling(this.db, runId);
  }

  purgeUser(userId: string): void {
    purgeAiBillingData(this.db, userId);
  }

  private requireUser(userId: string): void {
    if (!userExists(this.db, userId)) throw new PublicError("干员不存在");
  }
}

export function createAiBillingService(db: Database): AiBillingService {
  return new AiBillingService(db);
}
