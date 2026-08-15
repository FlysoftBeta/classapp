# AI billing

AI billing is a reservation and settlement ledger, not a mutable “credits”
number. It combines two plan windows with top-up balance while preserving exact
integer accounting and idempotency.

## Units

Product convention:

```text
100 credits = 1 CNY
1 credit = 1,000,000 micro-credits
```

Provider prices are configured as credits per one million tokens. Therefore:

```text
cost_microcredits =
  uncached_input_tokens × input_price
  + cached_input_tokens × cached_price
  + output_tokens × output_price
```

Aggregate one provider response, then round once. Rounding each component/call
up to a whole credit was the historical overcharging bug.

All persisted balances, reservations, usage, and ledger deltas use integer
micro-credits. Floating-point values do not cross the persistence boundary.

## Plan windows

An enrollment has start/end time plus policy-defined daily and weekly
allowances. Current keys are UTC calendar date and UTC Monday week. Weekend days
are ordinary accounting days; do not reintroduce a “five weekdays” assumption
unless the product policy explicitly changes and migrations/UI follow.

```text
plan_available = min(daily_remaining, weekly_remaining)
total_available = plan_available + top_up - active_reservations
```

Daily and weekly are independent ceilings, not balances that add together. The
UI shows allowance, used, remaining, and percentage for each.

## Reservation

Before provider work, reserve a conservative maximum under one operation/run
ID. In one transaction:

- ensure account/enrollment rows;
- calculate current windows and active reservations;
- reject insufficient availability;
- insert one reservation idempotently;
- reflect reserved amount in the account/ledger as designed.

No network call happens inside this transaction. A quote is informative; the
reservation transaction is authoritative under concurrency.

## Settlement

Settlement is idempotent by operation identity:

1. load active reservation;
2. calculate actual aggregated provider charge;
3. consume plan availability first and top-up second;
4. write usage split and ledger entries;
5. release unused reservation;
6. mark reservation settled;
7. record the charge on the run/operation.

Retry returns the already settled result and does not charge again. Failure or
startup reconciliation settles zero/actual known cost according to what the
provider completed, then releases the rest.

Actual charge cannot exceed the policy selected by the reservation without an
explicit, audited overage rule. A model/tool loop must bound maximum output and
attempts so a conservative reservation is meaningful.

## Administrative operations

`feature_manager` may:

- change policy for future assignments;
- assign/renew plan enrollment;
- top up by idempotency key and safe note;
- inspect account ledger and system aggregation.

Batch assignment is one Facade/UnitOfWork command, validates unique targets, and
records one coherent audit summary. Do not issue one client Action per selected
user.

System stock and daily consumption must define their accounting basis. The
current summary values active plans by weekly allowance plus remaining top-up
and reports collected usage by UTC day. It is an operational estimate, not
financial revenue recognition.

## Invariants

```text
stored amounts are safe integers ≥ 0 where semantically nonnegative
one active reservation per operation identity
settlement occurs at most once
top-up idempotency key applies at most once
reserved amount is released exactly once
sum(plan split + top-up split) = charged amount
provider work never holds SQLite transaction
purge cannot leave a live reservation
```

## Tests

- cached/uncached/output pricing and round-once behavior;
- daily boundary, UTC Monday boundary, enrollment start/end;
- simultaneous reservations racing for last availability;
- settlement retry and failure after each write stage;
- plan-first/top-up split;
- provider fallback with several attempt usages;
- cancellation/restart reconciliation;
- top-up/batch idempotency;
- schema migration from legacy whole-credit columns;
- purge of active and settled accounts.
