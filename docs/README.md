# ClassApp engineering guide

This tree is the project's engineering design memory. It records product
constraints, design intent, failure analysis, and current mechanisms so future
work can make informed decisions. It is neither an infallible specification nor
a catalog of every pattern that happens to exist in the code.

ClassApp is a school intranet application, not a generic Internet SaaS. Its
browser floor is Chrome 70–80, clients can lose the server for meaningful
periods, deployment may run on a concealed LAN with several ports, and the
application updates itself without a conventional CDN or package manager on
the host. Those constraints explain many choices that would be unusual in a
public cloud product: a monolithic browser bundle, a stable bootstrap Shell,
server-rendered document archives instead of PDF.js, a custom offline domain
projection, LAN client identity, and a launcher-owned rollback protocol.

## How to read this documentation

Read statements according to what they represent:

- **Product constraint** — a real deployment or domain condition such as the
  fixed browser, intermittent LAN, or meaning of a Group.
- **Design intent / invariant** — the failure or property a design is trying to
  address. Preserve it or explain why the premise has changed.
- **Current mechanism** — how the working tree presently realizes the design.
  It may be replaced when another mechanism handles the same concerns.
- **Known concern / preference** — experience that should prompt investigation,
  not a universal prohibition.

The working tree and its complete call paths were used as implementation
evidence when this guide was assembled. Historical documents and rewrite
notes were cross-checked but not accepted uncritically. Root `ARCHITECTURE.md`
is retained only as historical context. When code, documents, and the product
premise disagree, investigate the complete flow and update the relevant design
memory instead of forcing either side to remain artificially authoritative.

## Reading paths

For any product change, start with:

1. [Product context and design philosophy](./product-context.md)
2. [System architecture](./architecture.md)
3. [AI-agent change method](./engineering/agent-method.md)
4. [Known traps](./engineering/traps.md)
5. the relevant system and foundation documents

### Foundations

- [Occupancy and process composition](./foundations/server-occupancy.md)
- [Lifetimes, ownership, and composition](./foundations/lifetimes-and-ownership.md)
- [Invariants, transactions, and events](./foundations/invariants-and-transactions.md)
- [Authority, validation, and audit](./foundations/authority-validation-audit.md)
- [Errors, incidents, and containment](./foundations/errors-and-incidents.md)
- [Security and threat model](./foundations/security-threat-model.md)
- [Privacy and data lifecycle](./foundations/privacy-and-data-lifecycle.md)

### Offline architecture

- [Offline system overview](./offline/README.md)
- [Local data model and ownership](./offline/local-model.md)
- [Consistency and recovery protocols](./offline/consistency-and-recovery.md)
- [RemoteManager connection reliability](./offline/remote-connectivity.md)
- [Binary storage, retention, and quota](./offline/storage-and-quota.md)
- [Shell, HTTPS, and offline boot](./offline/shell-and-https.md)

### Cross-stack systems

- [Authentication and client trust](./systems/authentication.md)
- [Community, conversations, posts, and articles](./systems/community-and-content.md)
- [Document rendering and bundle reading](./systems/document-rendering.md)
- [Music and media runtime](./systems/music.md)
- [Server object storage and quota](./systems/server-storage.md)
- [AI harness and workspace](./systems/ai-harness.md)
- [AI billing](./systems/ai-billing.md)
- [Build, startup, deployment, and rollback](./systems/update-and-startup.md)
- [Administration workbench](./systems/admin-workbench.md)
- [Infinite scrolling and large readers](./systems/infinite-scrolling.md)
- [Learning, imports, announcements, and teaching support](./systems/auxiliary-domains.md)
- [Frontend state and UI boundaries](./systems/frontend-state-and-ui.md)
- [Observability and operations](./systems/observability-and-operations.md)

### Server data

- [Server data model and migration discipline](./foundations/server-data-model.md)

### Engineering playbook

- [AI-agent change method](./engineering/agent-method.md)
- [Repository, scripts, and test infrastructure](./engineering/repository-infrastructure.md)
- [Documentation maintenance](./engineering/documentation.md)
- [Coding standards](./engineering/coding-standards.md)
- [Testing and verification](./engineering/testing.md)
- [Known traps and rejected patterns](./engineering/traps.md)
- [Cross-stack change checklists](./reference/change-checklists.md)
- [Service and ownership catalog](./reference/ownership-catalog.md)
- [Architecture decision governance](./reference/architecture-decisions.md)
- [0001: Coordinator, Executor pool, and StickyRuntimes](./decisions/0001-coordinator-executor.md)

## Recurring design principles

1. Model the real product constraint before importing an industry convention.
2. Give each mutable fact, lifetime, policy, transaction, and activation pointer
   exactly one owner.
3. Separate objective facts, actor-specific projections, and user decisions.
4. Put authorization and legitimate path selection at public Facades; keep
   Services objective and Data exclusively responsible for SQL.
5. Treat offline data as a partial materialized projection with proofs of
   coverage, never as an unqualified second database.
6. Make every offline-writable decision declare its merge algebra.
7. Advance cursors, revisions, and active pointers only after the data they
   certify is durably published.
8. Publish observable side effects only after commit.
9. Let unrecoverable failures propagate to a containment boundary; do not turn
   programming errors into ordinary offline or business states.
10. Prefer direct migrations and explicit hard boundaries over compatibility
    layers for reconstructible data.
11. Treat leftover after return as occupancy, independent of layer names.
12. Test the invariant at the boundary where it can fail, including the real
    Chrome 70 production boot chain when browser compatibility is involved.
13. Do not copy a pattern merely because it exists in the repository. First
    determine whether it is intentional, repeated, documented, and verified.
