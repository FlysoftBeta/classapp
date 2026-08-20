# Administration workbench

The workbench is organized by responsibility and operation, not by database
table or Action name. Its mental model is:

```text
choose responsibility → inspect targets/evidence → select explicit operation
→ review consequences → execute one server command → show authoritative result
```

## Information architecture

- Overview: current actor roles and separation of role versus product feature.
- Personnel & access: active users, pending/OOBE identities, managed clients.
- Community: Groups, membership, contextual moderation.
- Product & billing: feature assignment, AI plan, quota, top-up and consumption.
- System: global policy, HTTPS, updates, backups, tools, Incidents.
- Governance: root-only role assignment and audit.

Navigation hides responsibilities unavailable to the current actor, but this is
only presentation. Every server operation reauthorizes in its Facade.

## Commands versus configuration

Configuration edits a durable set of fields and has Save/Cancel semantics.
Commands cause an imperative transition and belong in an action surface:
delete, deactivate, reset PIN, top up, assign plan, force membership, backup,
deploy, rollback, kill WPS, shutdown.

Deploy is not a fire-and-forget upload. The workbench must not treat every
connection reset as “server restarting”: an invalid or interrupted package
leaves the current process running. Show restart only after a successful
stage, and replace that message with the pending-confirmation panel once
`backup/` exists.

Do not bury commands in a generic edit form. Confirmation names target and
consequence. Destructive commands are visually distinct but do not rely on
color alone.

## Dense table contract

All large datasets share one reusable table contract:

- virtualized rows;
- sticky header;
- sticky stable identity column;
- horizontal scrolling contained within the table;
- dense, deliberate column widths independent of extreme content;
- user-selectable columns, with identity non-hideable;
- long text collapsed with a detail dialog/copy action;
- explicit loading, empty, partial, and error states;
- stable row key and keyset/server pagination where appropriate;
- persistent selection only while target generation remains valid.

Badges are for short categorical state. IDs, timestamps, numeric values, user
agents, error messages, and evidence use fields/columns, not a wall of badges.

## Selection and bulk operations

Single and bulk flows reuse the same semantic operation component. Bulk forms
use incremental patch semantics:

- checked: set all selected on;
- unchecked: set all selected off;
- indeterminate: values differ and no change is applied until user chooses;
- omitted field: preserve each target's current value.

One server Action performs the entire bulk operation transactionally where the
domain permits. The client never `Promise.all`s destructive single-row commands.
If the operation is necessarily per-target and partially successful, the Action
returns an explicit per-target result model and audit semantics are designed
accordingly.

## Help and evidence

Help explains operational mental models and consequences, not SQL, bit positions,
or internal class names. Examples:

- client admission explains identity evidence, whitelist, binding, lifetime;
- HTTPS explains certificate/chain/redirect/offline-entry consequences;
- update explains pending confirmation and automatic rollback;
- deactivation versus purge explains what historical data remains;
- AI billing explains daily/weekly ceilings versus top-up;
- Incidents explain grouping, build filtering, detail retention, and public IDs.

Evidence fields are privacy-sensitive. Show only to the responsible role,
truncate by default, support explicit reveal/copy, and never expose secrets.

## Optimistic UI

Administrative facts are server-authoritative. The UI may show progress but
does not optimistically claim a destructive/configuration command succeeded.
After response, apply returned canonical state or refresh the affected
projection. A failed command preserves selection/form input when safe so the
administrator can understand and retry.

## Audit and safety

Every sensitive successful command has a semantic audit entry. Confirmation and
help text align with actual deactivation/purge/rollback semantics. UI labels do
not promise atomicity or reversibility the server does not provide.

System tools are platform-specific and narrowly enumerated. Never accept an
arbitrary command, executable, path, or shell string from the browser.

## Accessibility and Chrome 70

- keyboard navigation and focus restoration after dialogs;
- selected/indeterminate state has textual/ARIA meaning;
- sticky/virtual layout tested at production viewport sizes;
- CSS fallbacks for unsupported flex gap/min/max patterns;
- no feature depends only on hover;
- long tables remain usable with touch and old Chromium rendering.
