import type { Actor } from "@/server/runtime/actor";
import type { ClientService } from "@/server/services/clientsService";
import type { AppStateService } from "@/server/services/appStateService";
import type { HttpsUpgradeService } from "@/server/services/httpsUpgradeService";
import type { AnnouncementService } from "@/server/services/announcementService";
import type {
  AdminSystemService,
  AdminSystemToolAction,
} from "@/server/services/adminSystemService";
import type { TeachDocumentsService } from "@/server/services/teachDocumentsService";
import type { AuditService } from "@/server/services/auditService";
import { PublicError } from "@/server/services/incidentService";
import { normalizeManifestUrl } from "@/server/validation/update";

export class AdministrationActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly clients: ClientService,
    private readonly appState: AppStateService,
    private readonly https: HttpsUpgradeService,
    private readonly announcements: AnnouncementService,
    private readonly system: AdminSystemService,
    private readonly teachDocuments: TeachDocumentsService,
    private readonly audit: AuditService,
  ) {}

  listClients(offset: number, query: string) {
    this.actor.requireRole("access_manager");
    return this.clients.list(offset, 50, query);
  }

  setClientLock(id: string, locked: boolean) {
    const admin = this.actor.requireRole("access_manager");
    if (locked) this.clients.lock(id);
    else this.clients.unlock(id);
    this.record(admin.id, "client.lock.update", "client", id, { locked });
    return { ok: true as const };
  }

  deleteClient(id: string) {
    const admin = this.actor.requireRole("access_manager");
    if (!this.clients.delete(id)) throw new PublicError("客户端不存在");
    this.record(admin.id, "client.delete", "client", id);
    return { ok: true as const };
  }

  promoteClient(id: string) {
    const admin = this.actor.requireRole("access_manager");
    this.clients.promote(id);
    this.record(admin.id, "client.promote", "client", id);
    return { ok: true as const };
  }

  updateClient(
    id: string,
    input: {
      remark?: string;
      whitelisted?: boolean;
      bound_user_id?: string | null;
    },
  ) {
    const admin = this.actor.requireRole("access_manager");
    this.clients.updateProps(id, input);
    this.record(admin.id, "client.update", "client", id, {
      fields: Object.keys(input),
    });
    return { ok: true as const };
  }

  whitelistCurrentClient() {
    const admin = this.actor.requireRole("access_manager");
    const clientId = this.actor.clientId();
    if (!clientId) throw new PublicError("无法识别当前设备，请刷新页面后重试");
    this.clients.promote(clientId);
    this.clients.whitelist(clientId);
    this.record(admin.id, "client.whitelist", "client", clientId);
    return { ok: true as const, client_id: clientId };
  }

  getConfig() {
    this.requireConfigReadAccess();
    const announcement = this.announcements.get();
    return {
      ...this.appState.getConfig(),
      https_redirect_enabled: this.https.isRedirectEnabled(),
      ...this.clients.config(),
      announcement_content: announcement.content,
      announcement_revision: announcement.revision,
      ...this.appState.getCloudUpdateConfig(),
    };
  }

  updateConfig(input: {
    idle_lock_enabled?: boolean;
    system_locked?: boolean;
    https_redirect_enabled?: boolean;
    whitelist_enabled?: boolean;
    identity_methods?: Array<"mac" | "ip" | "user_agent">;
    announcement_content?: string;
    cloud_deploy_enabled?: boolean;
    update_auto_check?: boolean;
    update_manifest_url?: string;
  }) {
    const actor = this.actor.requireUser();
    if (
      input.idle_lock_enabled !== undefined ||
      input.system_locked !== undefined
    ) {
      this.actor.requireRole("operations_assistant");
    }
    if (input.https_redirect_enabled !== undefined)
      this.actor.requireRole("operations");
    const updatesCloudConfig =
      input.cloud_deploy_enabled !== undefined ||
      input.update_auto_check !== undefined ||
      input.update_manifest_url !== undefined;
    if (updatesCloudConfig) this.actor.requireRole("operations");
    if (
      input.whitelist_enabled !== undefined ||
      input.identity_methods !== undefined
    ) {
      this.actor.requireRole("access_manager");
    }
    if (input.announcement_content !== undefined) {
      this.actor.requireRole("advanced_community_manager");
    }
    let cloudConfig = this.appState.getCloudUpdateConfig();
    const cloudInput = updatesCloudConfig
      ? {
          cloud_deploy_enabled: input.cloud_deploy_enabled,
          update_auto_check: input.update_auto_check,
          update_manifest_url:
            input.update_manifest_url === undefined
              ? undefined
              : normalizeManifestUrl(input.update_manifest_url),
        }
      : null;
    if (cloudInput) {
      const next = {
        ...cloudConfig,
        ...cloudInput,
        update_manifest_url:
          cloudInput.update_manifest_url ?? cloudConfig.update_manifest_url,
      };
      if (next.cloud_deploy_enabled && !next.update_manifest_url) {
        throw new PublicError("开启云端部署前请设置 Manifest 链接");
      }
      if (next.update_auto_check && !next.cloud_deploy_enabled) {
        throw new PublicError("自动检查依赖云端部署");
      }
    }
    const appConfig = this.appState.updateConfig({
      idle_lock_enabled: input.idle_lock_enabled,
      system_locked: input.system_locked,
    });
    if (input.https_redirect_enabled !== undefined) {
      this.https.setRedirectEnabled(input.https_redirect_enabled);
    }
    const clientConfig = this.clients.updateConfig({
      whitelist_enabled: input.whitelist_enabled,
      identity_methods: input.identity_methods,
    });
    const announcement =
      input.announcement_content !== undefined
        ? this.announcements.update(input.announcement_content)
        : this.announcements.get();
    if (cloudInput) {
      cloudConfig = this.appState.updateCloudUpdateConfig(cloudInput);
      this.system.cloudConfigChanged();
    }
    this.record(actor.id, "system.config.update", "runtime-config", null, {
      fields: Object.keys(input),
    });
    return {
      ok: true as const,
      ...appConfig,
      https_redirect_enabled: this.https.isRedirectEnabled(),
      ...clientConfig,
      announcement_content: announcement.content,
      announcement_revision: announcement.revision,
      ...cloudConfig,
    };
  }

  listBackups() {
    this.actor.requireRole("operations");
    return { backups: this.system.listBackups() };
  }

  httpsStatus() {
    this.actor.requireRole("operations");
    return this.system.getHttpsStatus();
  }

  async createBackup() {
    const admin = this.actor.requireRole("operations");
    const backups = await this.system.createBackup();
    this.record(admin.id, "backup.create", "backup-set");
    return { ok: true as const, backups };
  }

  deleteBackup(name: string) {
    const admin = this.actor.requireRole("operations");
    this.system.deleteBackup(name);
    this.record(admin.id, "backup.delete", "backup", name);
    return { ok: true as const };
  }

  downloadBackup(name: string) {
    this.actor.requireRole("operations");
    return this.system.downloadBackup(name);
  }

  async deployPackage(bytes: Uint8Array) {
    const admin = this.actor.requireRole("operations");
    const result = await this.system.deployPackage(bytes);
    this.record(admin.id, "runtime.deploy", "runtime-package");
    return result;
  }

  updateStatus() {
    this.actor.requireRole("operations");
    return this.system.getUpdateStatus();
  }

  checkCloudUpdate() {
    this.actor.requireRole("operations");
    return this.system.checkCloudUpdate();
  }

  async installCloudUpdate() {
    const admin = this.actor.requireRole("operations");
    const result = await this.system.installCloudUpdate();
    this.record(admin.id, "runtime.cloud_update.install", "runtime-package");
    return result;
  }

  confirmUpdate() {
    const admin = this.actor.requireRole("operations");
    this.system.confirmUpdate();
    this.record(admin.id, "runtime.update.confirm", "runtime");
    return { ok: true as const };
  }

  rollback() {
    const admin = this.actor.requireRole("operations");
    const result = this.system.rollback();
    this.record(admin.id, "runtime.rollback", "runtime");
    return result;
  }

  runTool(action: AdminSystemToolAction) {
    const admin = this.actor.requireRole("operations_assistant");
    const result = this.system.runTool(action);
    this.record(admin.id, "support.tool.run", "runtime-tool", action);
    return result;
  }

  listTeachDocuments() {
    this.actor.requireRole("operations_assistant");
    return {
      documents: this.teachDocuments.list().map((document) => ({
        id: document.id,
        application: document.application,
        document_type: document.document_type,
        name: document.name,
        file_size: document.file_size,
        created_at: document.created_at,
      })),
      monitor_available: process.platform === "win32",
    };
  }

  async cleanupTeachDocuments() {
    const admin = this.actor.requireRole("operations_assistant");
    const deleted = await this.teachDocuments.cleanupAll();
    this.record(
      admin.id,
      "teach_documents.cleanup",
      "teach-document-set",
      null,
      {
        deleted,
      },
    );
    return { ok: true as const, deleted };
  }

  downloadTeachDocument(id: string) {
    this.actor.requireRole("operations_assistant");
    return this.teachDocuments.download(id);
  }

  private record(
    actorId: string,
    action: string,
    targetKind: string,
    targetId?: string | null,
    details?: Record<string, unknown>,
  ) {
    this.audit.record({ actorId, action, targetKind, targetId, details });
  }

  private requireConfigReadAccess(): void {
    this.actor.requireUser();
    const canReadConfig =
      this.actor.hasRole("operations") ||
      this.actor.hasRole("operations_assistant") ||
      this.actor.hasRole("access_manager") ||
      this.actor.hasRole("advanced_community_manager");
    if (!canReadConfig) throw new PublicError("无权限");
  }
}
