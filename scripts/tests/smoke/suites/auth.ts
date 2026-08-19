import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeAuth(runtime: SmokeRuntime): Promise<void> {
  const probe = await runtime.client.expectOk("probeAppStateAction", []);
  assert.equal(probe.user?.id, runtime.userId);
  assert.equal(probe.session_valid, true);

  const me = await runtime.client.expectOk("getClientMeAction", []);
  assert.equal(typeof me.client_id, "string");
  assert.ok(me.client_id);

  const anonymous = await runtime.openClient();
  const anonymousProbe = await anonymous.expectOk("probeAppStateAction", []);
  assert.equal(anonymousProbe.reason, "anonymous");
  assert.equal(anonymousProbe.user, null);

  const wrongPin = await anonymous.call("loginPinAction", ["000000"], null);
  assert.equal(wrongPin.ok, true);
  if (wrongPin.ok) {
    assert.ok("error" in wrongPin.data);
  }

  const unauthenticated = await anonymous.call(
    "fetchConversationsAction",
    [],
    runtime.userId,
  );
  assert.equal(unauthenticated.ok, false);
}
