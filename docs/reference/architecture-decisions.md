# Architecture decision governance

ClassApp has repeatedly undergone deep rewrites. Code records what survived;
it rarely records why alternatives were rejected. This lightweight decision
process preserves reasoning without turning documentation into ceremony.

## When a decision record is required

Write a record before or with a change that:

- changes an invariant, occupancy, ownership boundary, lifetime, or dependency
  direction;
- adds a persistence/cache layer, protocol, port, activation pointer, or source
  of truth;
- changes offline merge, coverage, purge, quota, or recovery semantics;
- changes authority, validation, audit, privacy, or Incident behavior;
- adds a runtime/library with material Chrome 70–80, Windows, native, licensing,
  or bundle consequences;
- introduces a compatibility period instead of direct migration;
- rejects an apparently standard architecture because of product constraints.

Routine implementation choices do not need a record. Update the relevant
system doctrine directly when the decision is now an enduring rule.

## Record template

Store accepted records under `docs/decisions/` using
`NNNN-short-title.md`.

```markdown
# NNNN: Decision title

Status: proposed | accepted | superseded | rejected
Date: YYYY-MM-DD
Owners: domain/layer owners
Supersedes: optional record IDs

## Context

Product constraints, current mechanism, failure being solved, and evidence.

## Invariants

Precise conditions the decision must preserve.

## Decision

Chosen ownership, data/flow model, and cutover boundary.

## Alternatives considered

Real alternatives and why each fails or costs more under this project premise.

## Failure and recovery

Crash/disconnect/concurrency/actor-switch windows and repair owner.

## Consequences

Benefits, costs, operational burden, compatibility and licensing implications.

## Verification

Tests or observations that can falsify the claimed invariants.
```

## Evidence standard

A decision is not justified by “best practice,” “cleaner,” or “more scalable.”
Name the project constraint and failure model. Evidence may include an actual
call path, target-browser run, database transaction boundary, reproduction,
operational incident, size measurement, or controlled alternative experiment.

Distinguish:

- product invariant: cannot change without changing intended behavior;
- architecture rule: selected default, changeable by a stronger decision;
- current mechanism: replaceable implementation detail;
- repository accident: pattern with no positive authority.

This distinction prevents an AI agent from canonizing every repeated mistake.

## Decision process

1. Trace the complete affected flow and identify all owners.
2. Write context and invariants before choosing the mechanism.
3. Compare at least the credible incumbent and proposed alternatives.
4. Define direct migration/cutover and deletion of obsolete paths.
5. Review cross-stack effects: startup, offline, authority, privacy, incidents,
   audit, quota, purge, compatibility, packaging, and operations.
6. Implement and verify the falsifiable invariants.
7. Mark the record accepted and link it from affected doctrine/code comments.

Records are immutable history after acceptance except for typo/link repairs.
If the decision changes, add a new record and mark the old one superseded. The
new record must explain which premise, evidence, or trade-off changed.

## AI-agent rule

An agent may propose a decision record; it must not use one to silently expand
the requested feature. If implementation reveals a conflict with accepted
doctrine, report the conflict and either update the governing documentation as
part of the authorized change or stop for a product decision. Do not preserve
two models behind a compatibility shim while calling both “temporary.”

The absence of a record is not permission to invent architecture. Follow the
existing owners and doctrine, and record only material new judgment.
