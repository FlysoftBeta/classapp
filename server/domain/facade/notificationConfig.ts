import type { Actor } from "@/server/session/session";
import type {
  NotificationConfig,
  NotificationConfigService,
} from "@/server/services/notificationConfigService";

export class NotificationConfigActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly notificationConfig: NotificationConfigService,
  ) {}

  async get(): Promise<NotificationConfig> {
    const user = await this.actor.requireUser();
    return this.notificationConfig.get(user.id);
  }

  async setDoNotDisturb(enabled: boolean): Promise<NotificationConfig> {
    const user = await this.actor.requireUser();
    return this.notificationConfig.setDoNotDisturb(user.id, enabled);
  }
}

export type { NotificationConfig };
