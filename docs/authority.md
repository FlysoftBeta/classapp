# Authority

ClassApp expresses authority directly in Facade code. It does not define a
general capability language. Roles, feature access, account state,
relationships, and quotas are separate facts that a Facade may combine.

## Administrative roles

`administrator` is the prerequisite administrative identity and grants access
to the management workbench. It does not by itself grant a sensitive action.

| Role                         | Responsibility                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `root`                       | Assign and revoke administrative roles.                                             |
| `operations`                 | Incidents, HTTPS, update lifecycle, and backups.                                    |
| `feature_manager`            | Product features, AI plans, quota, and top-up.                                      |
| `operations_assistant`       | Lock settings and low-risk convenience tools.                                       |
| `access_manager`             | Clients, new users, and ghost users.                                                |
| `community_manager`          | Moderation, credential reset, group creation, and direct content removal.           |
| `advanced_community_manager` | User deletion/profile changes, group changes, forced membership, and announcements. |

Every specialized role requires `administrator`.
`advanced_community_manager` additionally requires `community_manager`.
`root` controls role assignment but does not implicitly receive the other
specialized roles.

Role updates are one transaction. Removing `administrator` removes every
specialized role. The last `root` cannot be removed or deactivated.

## Public checks

Facade checks state their real logic in code: the required role, ownership,
membership, target state, and other conditions remain visible at the public
entry point. Actor primitives may require one named role or answer whether the
Actor has one named role. When several roles legitimately reach the same entry,
the Facade gives that condition a business name and spells out the alternatives;
it does not pass an unexplained role array to a generic guard. No runtime
role-to-capability mapping is the source of truth.

The client receives a presentation projection for navigation and available
controls. It is never authoritative; every mutation is checked again by the
server Facade.

## Feature access

User product features are semantic booleans on the wire. SQLite may compress
them into a `feature_bitset`, but its bit positions are private to Data. The
administrative role bitset and product feature bitset are not combined.

## Audit

Administrative mutations append a structured audit entry with the Actor,
action, target, timestamp, and a safe summary. Role changes, moderation,
credit adjustments, deployment, backup access, and destructive operations are
audited. Secrets and content bodies are not copied into audit records.
