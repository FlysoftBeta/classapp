import type { Database } from "better-sqlite3";
import {
  ADMIN_ROLES,
  adminRoleSchema,
  type AdminRole,
} from "@/shared/authority";

export function listUserRoles(db: Database, userId: string): AdminRole[] {
  return (
    db
      .prepare(
        `SELECT role FROM user_admin_roles
         WHERE user_id = ? ORDER BY granted_at, role`,
      )
      .all(userId) as Array<{ role: string }>
  ).map((row) => adminRoleSchema.parse(row.role));
}

export function countUsersWithRole(db: Database, role: AdminRole): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM user_admin_roles WHERE role = ?")
      .get(role) as { count: number }
  ).count;
}

export function grantUserRole(
  db: Database,
  input: { userId: string; role: AdminRole; grantedBy: string | null },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO user_admin_roles (user_id, role, granted_by)
     VALUES (?, ?, ?)`,
  ).run(input.userId, input.role, input.grantedBy);
}

export function revokeUserRole(
  db: Database,
  userId: string,
  role: AdminRole,
): void {
  db.prepare("DELETE FROM user_admin_roles WHERE user_id = ? AND role = ?").run(
    userId,
    role,
  );
}

export function revokeAllUserRoles(db: Database, userId: string): void {
  db.prepare("DELETE FROM user_admin_roles WHERE user_id = ?").run(userId);
}

export function replaceUserRoles(
  db: Database,
  input: {
    userId: string;
    roles: readonly AdminRole[];
    grantedBy: string | null;
  },
): void {
  revokeAllUserRoles(db, input.userId);
  for (const role of ADMIN_ROLES) {
    if (input.roles.includes(role)) {
      grantUserRole(db, {
        userId: input.userId,
        role,
        grantedBy: input.grantedBy,
      });
    }
  }
}
