import { transport } from "./remote/transport";

export function isForcedOffline(): boolean {
  return transport.isForcedOffline();
}

export function setForcedOffline(enabled: boolean): void {
  transport.setForcedOffline(enabled);
}
