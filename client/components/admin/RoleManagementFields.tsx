import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Typography from "@mui/material/Typography";
import {
  ADMIN_ROLES,
  ADMIN_ROLE_DESCRIPTIONS,
  ADMIN_ROLE_LABELS,
  roleDependencies,
  type AdminRole,
} from "@/shared/authority";
import {
  IncrementalCheckbox,
  type IncrementalBoolean,
} from "./IncrementalField";

export type RoleChanges = Record<AdminRole, IncrementalBoolean>;
export type RoleAggregateStates = Record<
  AdminRole,
  "enabled" | "disabled" | "mixed"
>;

export function createUnchangedRoleChanges(): RoleChanges {
  return Object.fromEntries(
    ADMIN_ROLES.map((role) => [role, "unchanged"]),
  ) as RoleChanges;
}

export function aggregateRoleStates(
  users: Array<{ administration: { roles: AdminRole[] } }>,
): RoleAggregateStates {
  return Object.fromEntries(
    ADMIN_ROLES.map((role) => {
      const count = users.filter((user) =>
        user.administration.roles.includes(role),
      ).length;
      return [
        role,
        count === 0 ? "disabled" : count === users.length ? "enabled" : "mixed",
      ];
    }),
  ) as RoleAggregateStates;
}

export function changeRoleSet(
  roles: readonly AdminRole[],
  role: AdminRole,
  enabled: boolean,
): AdminRole[] {
  const next = new Set(roles);
  if (enabled) {
    next.add(role);
    for (const dependency of roleDependencies(role)) next.add(dependency);
  } else {
    const removed = new Set<AdminRole>([role]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of ADMIN_ROLES) {
        if (
          !removed.has(candidate) &&
          roleDependencies(candidate).some((dependency) =>
            removed.has(dependency),
          )
        ) {
          removed.add(candidate);
          changed = true;
        }
      }
    }
    for (const item of removed) next.delete(item);
  }
  return ADMIN_ROLES.filter((candidate) => next.has(candidate));
}

export function changeRoleChanges(
  changes: RoleChanges,
  role: AdminRole,
  value: IncrementalBoolean,
): RoleChanges {
  const next = { ...changes, [role]: value };
  if (value === "enabled") {
    for (const dependency of roleDependencies(role)) {
      next[dependency] = "enabled";
    }
  } else if (value === "disabled") {
    const removed = new Set<AdminRole>([role]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of ADMIN_ROLES) {
        if (
          !removed.has(candidate) &&
          roleDependencies(candidate).some((dependency) =>
            removed.has(dependency),
          )
        ) {
          removed.add(candidate);
          changed = true;
        }
      }
    }
    for (const item of removed) next[item] = "disabled";
  }
  return next;
}

export function applyRoleChanges(
  roles: readonly AdminRole[],
  changes: RoleChanges,
): AdminRole[] {
  let next = [...roles];
  for (const role of ADMIN_ROLES) {
    if (changes[role] === "enabled") next = changeRoleSet(next, role, true);
  }
  for (const role of ADMIN_ROLES) {
    if (changes[role] === "disabled") next = changeRoleSet(next, role, false);
  }
  return next;
}

function RoleLabel({ role }: { role: AdminRole }) {
  return (
    <Box>
      <Typography variant="body2">{ADMIN_ROLE_LABELS[role]}</Typography>
      <Typography variant="caption" color="text.secondary">
        {ADMIN_ROLE_DESCRIPTIONS[role]}
      </Typography>
    </Box>
  );
}

type RoleManagementFieldsProps =
  | {
      mode: "single";
      roles: AdminRole[];
      onChange: (roles: AdminRole[]) => void;
    }
  | {
      mode: "batch";
      changes: RoleChanges;
      aggregate: RoleAggregateStates;
      onChange: (changes: RoleChanges) => void;
    };

export function RoleManagementFields(props: RoleManagementFieldsProps) {
  return (
    <Box sx={{ display: "grid" }}>
      {ADMIN_ROLES.map((role) =>
        props.mode === "single" ? (
          <FormControlLabel
            key={role}
            control={
              <Checkbox
                size="small"
                checked={props.roles.includes(role)}
                onChange={(_, enabled) =>
                  props.onChange(changeRoleSet(props.roles, role, enabled))
                }
              />
            }
            label={<RoleLabel role={role} />}
          />
        ) : (
          <IncrementalCheckbox
            key={role}
            label={<RoleLabel role={role} />}
            value={props.changes[role]}
            aggregate={props.aggregate[role]}
            onChange={(value) =>
              props.onChange(changeRoleChanges(props.changes, role, value))
            }
          />
        ),
      )}
    </Box>
  );
}
