import type { AuthService } from "@/server/services/authService";

export class AuthenticationFacade {
  constructor(private readonly auth: AuthService) {}

  autoLogin() {
    return this.auth.autoLogin();
  }

  login(pin: string) {
    return this.auth.login(pin);
  }

  completeOobe(input: {
    oobe_token: string;
    handle: string;
    username: string;
    new_pins: string[];
  }) {
    return this.auth.completeOobe(input);
  }

  logout(token: string | null) {
    if (token) this.auth.logout(token);
    return { ok: true as const };
  }
}
