import { z } from "zod";

export const ADMIN_ROLES = [
  "administrator",
  "root",
  "operations",
  "feature_manager",
  "operations_assistant",
  "access_manager",
  "community_manager",
  "advanced_community_manager",
] as const;

export const adminRoleSchema = z.enum(ADMIN_ROLES);
export type AdminRole = z.infer<typeof adminRoleSchema>;

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  administrator: "管理员",
  root: "根管理员",
  operations: "运维",
  feature_manager: "功能管理",
  operations_assistant: "协助运营",
  access_manager: "准入管理",
  community_manager: "社区管理",
  advanced_community_manager: "高级社区管理",
};

export const ADMIN_ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  administrator: "进入管理工作台的基础身份；不单独授予具体管理操作。",
  root: "分配和撤销管理员角色，并保障管理权限可恢复。",
  operations: "处理 Incidents、HTTPS、更新和数据库备份。",
  feature_manager: "管理产品功能、AI 套餐、额度和充值。",
  operations_assistant: "管理系统锁定设置和低风险便利工具。",
  access_manager: "管理客户端准入、新用户和幽灵用户。",
  community_manager: "处理封禁、禁言、凭据重置、群组创建和内容强制删除。",
  advanced_community_manager:
    "删除用户、修改用户或群组资料、强制调整成员和发布公告。",
};

export const adminAccessSchema = z
  .object({
    available: z.boolean(),
    roles: z.array(adminRoleSchema),
  })
  .strict();

export type AdminAccess = z.infer<typeof adminAccessSchema>;

export function roleDependencies(role: AdminRole): readonly AdminRole[] {
  if (role === "administrator") return [];
  if (role === "advanced_community_manager") {
    return ["administrator", "community_manager"];
  }
  return ["administrator"];
}
