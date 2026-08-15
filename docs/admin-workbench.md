# Administration workbench

The workbench is organized by responsibility rather than by database table or
wire Action. Its mental model is: **choose a responsibility, inspect a target,
then perform an explicit operation**.

## Navigation

- Overview explains the current Actor's roles and the separation between
  administrative roles and product features.
- Personnel & access contains users, pending/OOBE identities, and clients.
- Community contains groups and contextual moderation. There is deliberately
  no unified “all posts” surveillance page.
- Product & billing contains feature assignment, AI plans, quota policy,
  top-ups, stock, and daily consumption.
- System contains global policy, operations, tools, incidents, and root audit.

Pages that the Actor cannot use are absent from navigation. This is only a
presentation projection; Facades authorize every operation again.

## Interaction rules

- Similar bulk operations share a selection model and one atomic server
  Action. Feature assignment is never implemented as a client `Promise.all`
  over partial mutations.
- Dense datasets use one DataGrid contract: virtual rows, sticky header and
  identity column, horizontal containment, selectable columns, and an explicit
  long-text detail dialog.
- Badges are reserved for short state. Values, timestamps, identifiers, and
  long evidence remain columns or labeled fields.
- Help text explains consequences and workflow, not bit positions, SQL, or
  protocol details.
- Destructive operations state the target and use a dedicated confirmation;
  server audit records the successful result.

The same shell and spacing rules apply to every section so individual pages do
not invent their own tab geometry, table scrolling, or information hierarchy.
