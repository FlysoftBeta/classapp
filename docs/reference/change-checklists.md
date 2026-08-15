# Cross-stack change checklists

Use these as prompts, not a substitute for the design ledger.

## New or changed Action

- semantic input/output and checked branches defined in shared schema;
- strict argument and server-output validation;
- Action is a thin adapter to one public Facade operation;
- actor label/credential epoch preserved;
- Facade states authority and transaction boundary;
- Service/Data do not learn transport details;
- error category and Incident context defined;
- client API/interact path unwraps and normalizes once;
- event/reconnect/offline behavior covered;
- protocol/build compatibility boundary decided.

## New persisted server fact

- stable identity, ownership, invariants, deletion semantics;
- normalized schema, constraints, indexes/query plan;
- Data-only SQL and row mapping;
- ordered migration from every supported schema version;
- transaction/event/audit behavior;
- deactivation/purge/backup/rollback implications;
- DTO exposure minimized and semantically converted;
- migration and rollback verification.

## New offline-writable decision

- actor/claimant and stable object identity;
- separate canonical base and proposal;
- merge algebra and exact-tie rule;
- monotonic stamp/operation ID;
- response acknowledgement cannot clear newer proposal;
- access-loss dormant behavior;
- reconnect flush order and idempotent server command;
- never-evict classification;
- actor-switch and response-reorder tests.

## New cached collection

- authoritative order and stable tie-breaker;
- root and cursor direction semantics;
- coverage representation and extension proof;
- snapshot/revision/event relationship;
- merge rule for equal/newer entity versions;
- empty coverage behavior;
- quota trimming only from legal boundary;
- reconnect repair and actor isolation;
- Infini provider behavior without OFFSET assumptions.

## New binary/document resource

- immutable logical/content identity;
- streaming and batch bounds;
- extent/generation publication;
- raw/stored sizes, encoding, checksum;
- partial download/restart/resume state;
- retention claim and complete materialization proof;
- quota eviction/GC;
- sandbox/MIME/path/content validation;
- Chrome 70 memory/API verification;
- deletion/purge artifact compensation.

## New Service or Runtime mechanism

- coherent mechanism and explicit exclusions;
- lifetime: process, request, or operation;
- owned Data/files/external clients;
- public operations and objective invariants;
- collaborators injected through Composition/Runtime;
- Facts and read-your-writes invalidation;
- transaction/idempotency/event semantics;
- startup reconciliation/cancellation/shutdown if process-bound;
- purge/deactivation/audit/Incident responsibilities.

## Authority/admin change

- responsibility role and prerequisite;
- owner/member/moderator alternative paths visible in Facade;
- client projection non-authoritative;
- atomic single/bulk command;
- safe audit summary in unit of work;
- destructive confirmation and help text;
- last-root/recovery authority protected;
- no secrets/content surveillance added accidentally.

## Shell/HTTPS/update change

- one build identity and singular owners preserved;
- Shell syntax/API supported directly by Chrome 70;
- independent Shell/app schema markers and version race;
- cache-control and active pointers;
- secure/insecure/multi-port/CORS/WebSocket contract;
- stage/validate/publish/compensate sequence;
- launcher pending metadata survives restart;
- app+DB rollback pairing;
- fixed Chrome 70 production E2E and target package test.

## Completion checklist for agents

- relevant design concerns and invariants identified;
- repository-wide producers/consumers migrated directly;
- obsolete code removed;
- exact tests are executable and were run;
- no unrelated user working-tree changes touched;
- relevant engineering documentation updated;
- handoff states commands, results, and residual risks.
