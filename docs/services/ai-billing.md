# AI billing Service

AI billing uses two independent plan accounting windows plus an additional
top-up balance. It is a quota and settlement mechanism owned by
`AiBillingService`; `AiService` is its consumer, while feature access and
administrative authority remain Facade decisions.

## Units and price conversion

The public unit is a `credit`, with the product accounting convention
`100 credits = 1 CNY`. SQLite stores integer micro-credits:

```text
1 credit = 1,000,000 micro-credits
```

Provider model prices are configured as credits per million tokens. Therefore
`tokens × configured price` already yields micro-credits. Usage for one
provider response is aggregated first and rounded once. This avoids the old
bug where every small provider call was rounded up to a whole credit.

## Plan windows

An active enrollment has a configured daily allowance, weekly allowance, and
start/end timestamps. Daily keys are UTC calendar dates. Weekly keys are UTC
Mondays. Saturday and Sunday are ordinary accounting days: there is no weekday
enforcement and no relationship such as `weekly <= daily × 5` is imposed.

Plan availability is:

```text
min(daily remaining, weekly remaining)
```

The UI presents each window as allowance, used, remaining, and percentage.
Plan allowance is not described as a top-up credit balance.

## Reservations and settlement

Before a provider operation starts, the Service atomically reserves a
conservative micro-credit amount. Availability is:

```text
plan availability + top-up balance - active reservations
```

Settlement is idempotent by operation/run identity. Actual charge consumes the
plan window first, then top-up. Unused reservation is released. Daily usage
records store actual collected charge and its plan/top-up split; provider
network work is never performed while a SQLite transaction is held.

## Administration and aggregation

`feature_manager` paths can update the shared policy, assign an enrollment,
and add top-up credits. The management summary reports:

- system stock: active plans valued at the current weekly allowance plus
  remaining top-up;
- actual collected consumption grouped by UTC day;
- the current policy used for new assignments.

Top-up uses an idempotency key. Every successful policy, assignment, and
top-up path records an audit summary without copying secrets or AI content.
