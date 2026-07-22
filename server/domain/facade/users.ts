import type { Actor } from "@/server/session/session";
import {
  type CreateUserParams,
  type ResetPinParams,
  type UpdateSelfProfileParams,
  type UpdateUserParams,
  type UserService,
} from "@/server/services/usersService";

export class UserActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly users: UserService,
  ) {}

  async list(input: { q?: string; offset?: number }) {
    await this.actor.requireAdmin();
    return this.users.list(input.q ?? "", input.offset ?? 0);
  }

  async create(input: CreateUserParams) {
    await this.actor.requireAdmin();
    return this.users.create(input);
  }

  async update(
    input: UpdateUserParams & {
      userId: string;
      mute_hours?: number;
      unmute?: boolean;
      ban_hours?: number;
      unban?: boolean;
    },
  ) {
    await this.actor.requireAdmin();

    if (input.unmute === true) {
      this.users.unmute(input.userId);
    } else if (input.mute_hours !== undefined) {
      this.users.mute(input.userId, input.mute_hours);
    }

    if (input.unban === true) {
      this.users.unban(input.userId);
    } else if (input.ban_hours !== undefined) {
      this.users.ban(input.userId, input.ban_hours);
    }

    const profileBody = {
      handle: input.handle,
      username: input.username,
      feature_mask: input.feature_mask,
      pin: input.pin,
    };
    const hasProfileUpdate = Object.values(profileBody).some(
      (value) => value !== undefined,
    );
    if (hasProfileUpdate) {
      return this.users.update(input.userId, profileBody);
    }

    return this.users.get(input.userId);
  }

  async delete(userId: string): Promise<void> {
    const admin = await this.actor.requireAdmin();
    this.users.delete(userId, admin.id);
  }

  async updateSelf(input: UpdateSelfProfileParams) {
    const user = await this.actor.requireUser();
    return this.users.updateSelfProfile(user.id, input);
  }

  async resetSelfPin(input: ResetPinParams): Promise<void> {
    const user = await this.actor.requireUser();
    this.users.resetSelfPin(user.id, input);
  }
}
