# Documentation maintenance

The documentation is engineering design memory. Its value comes from preserving
the product premise, the reasoning behind unusual choices, known failure modes,
and enough of the current mechanism to guide investigation. It should neither
become an unchangeable constitution nor drift into a collection of unrelated
LLM summaries.

## Roles of the entry documents

- Root `README.md` introduces the product, architecture, development entry
  points, and documentation to a human contributor.
- Root `AGENTS.md` gives an agent a fast project map, infrastructure summary,
  working flow, recurring design questions, and direct links for common change
  areas. Its paths must name the current modules rather than an idealized or
  historical directory layout.
- `docs/README.md` explains how to interpret and navigate the design memory.
- Topic documents own detailed domain semantics, reasoning, current mechanisms,
  failure analysis, and focused review guidance.

Do not move subsystem detail into `AGENTS.md` merely because it is important.
Importance determines whether it should be discoverable; ownership determines
where its full explanation belongs. AGENTS may keep a one-line orientation and
link directly to the owning document. Common work such as server/client data
model changes, offline consistency, authentication, UI state, documents, AI,
and updates should not require opening only a root index and guessing the next
document.

## Classify statements before strengthening them

Use wording that reflects the nature of the claim:

| Kind                       | Meaning                                   | Typical wording                                       |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| product constraint         | externally real premise                   | “The target browser is Chrome 70–80.”                 |
| design intent / invariant  | property or failure the design addresses  | “A published revision certifies durable rows.”        |
| current mechanism          | present implementation, replaceable       | “The current launcher records pending activation in…” |
| preference / caution       | experience worth considering              | “Prefer…”, “Be cautious when…”, “Consider…”           |
| open question / limitation | unresolved trade-off or accepted weakness | “The current LWW clock can be dominated by…”          |

Reserve unconditional `must`, `never`, and “wrong” for genuine product
constraints, safety boundaries, or correctness conditions whose violation can
be explained. Do not promote a repository convention or one successful
implementation into an invariant merely to make the document sound decisive.

Conversely, do not weaken a real invariant into vague advice. If a cursor can
cause durable data loss when published early, state the failure precisely.
Calibrated language is more useful than uniformly strong or uniformly cautious
language.

## One detailed home for each idea

A detailed rule or mechanism should have one owning document. Other documents
summarize only the aspect needed for their flow and link to that owner. Avoid
copying the same explanation into AGENTS, architecture, testing, and a system
document; duplicated prose inevitably evolves into contradictory rules.

Choose ownership by the concern, not by the file being edited:

- project premise and domain philosophy → `product-context.md`;
- cross-stack topology → `architecture.md`;
- lifetime, transaction, authority, error, security, or server data concerns →
  the corresponding `foundations/` document;
- offline representation and protocols → `offline/`;
- end-to-end product mechanism → `systems/`;
- implementation, tests, scripts, documentation, and agent workflow →
  `engineering/`;
- reusable change/ownership/decision aids → `reference/`.

Extend an existing owner before creating another document. Create a new file
when the subject has a distinct audience or lifecycle and would otherwise make
its current owner incoherent. Add it to `docs/README.md` in the same change.

## Write reasoning, not a source-code mirror

Prefer documentation that survives refactoring:

- domain meaning and product constraints;
- owners, lifetimes, identities, and publication points;
- reasons an apparently conventional alternative failed the real premise;
- failure windows, recovery, limitations, and trade-offs;
- enough implementation anchors to find the current code;
- questions or tests that can falsify a claimed property.

Avoid exhaustive function/class listings, line-by-line narratives, or large
copied type definitions that the source already expresses better. A short
current-mechanism section is useful when topology is otherwise hard to find,
but label it as current and update or remove it when the topology changes.

Use mathematical notation only when it makes identity, ordering, atomicity,
coverage, or state transitions more precise. Decorative formulas and diagrams
create authority without clarity.

## Update documentation during the change

Do not defer all documentation work to the final cleanup. While investigating
and implementing:

1. correct an obsolete mechanism when it is discovered and relevant;
2. record newly understood failure reasoning near its owning concept;
3. update the document when the implementation changes its described flow;
4. remove statements, links, examples, and files made obsolete by a direct
   migration;
5. keep unresolved conflicts explicit instead of editing prose to pretend the
   implementation is already coherent;
6. revisit AGENTS only when the quick project map, infrastructure entry, working
   flow, common-change index, or recurring questions changed.

Documentation updates remain within task scope. Do not rewrite unrelated
documents for style while implementing a local feature. If investigation finds
a larger contradiction that cannot be responsibly resolved in the current
change, state it as a known issue or handoff risk.

## Style and terminology

- Write engineering documentation in English; product UI text and examples may
  use Chinese when the language itself matters.
- Build from context to design meaning to mechanism to failures. Do not begin
  with unexplained implementation details.
- Prefer direct prose and domain terms over generic slogans such as “best
  practice,” “clean,” “scalable,” or “robust.” Name the actual constraint or
  failure.
- Preserve established terms and capitalization: Actor, Coordinator, Scope,
  StickyRuntime, Executor, Facade, Service, Data, Interact, Shell, Launcher,
  Incident, UnitOfWork.
- Distinguish server truth, Actor projection, local user decision, and
  reconstructible materialization consistently.
- Use examples to expose a boundary or counterexample, not to turn one current
  table or method into an eternal API.
- Link to the owning document with relative Markdown links. Do not depend on
  deleted drafts or private prompts for necessary reasoning.
- State dates, schema versions, ports, targets, and command behavior only when
  useful; treat them as current mechanism and update them with the source.

## Documentation review

When a change updates documentation, check:

- Does each strong statement identify a real premise or explain the failure it
  prevents?
- Did a preference accidentally become a universal law?
- Is detailed content in its owning document rather than duplicated in AGENTS?
- Does the description distinguish intent from current mechanism?
- Were obsolete paths, terms, examples, compatibility branches, and links
  removed?
- Do new facts agree with the code, schema, package scripts, and adjacent docs?
- Are remaining limitations and uncertainty stated honestly?
- Do all relative links resolve, and does Markdown formatting pass?

A document is not improved merely by becoming longer or more comprehensive. It
is improved when the next contributor can recover the relevant reasoning,
verify the current mechanism, and change it without unknowingly reviving an old
failure.
