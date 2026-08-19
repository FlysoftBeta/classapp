import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dmConvId } from "@/shared/conversations/id";
import {
  ProtocolError,
  startSmokeServer,
  uniqueHandle,
  uniquePin,
  type SmokeSession,
} from "../harness/smokeServer";

describe("smoke: protocol and API", () => {
  let session!: SmokeSession;

  before(async () => {
    session = await startSmokeServer();
  });

  after(async () => {
    await session?.close();
  });

  describe("protocol", () => {
    test("hello advertises the isolated build id", () => {
      assert.equal(session.client.buildId, "test");
    });

    test("unknown actions fail as contract panics", async () => {
      const result = await session.client.requestRaw(
        "notARealAction",
        [],
        session.admin.user.id,
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error.message, /协议|请求/);
      assert.match(result.error.incidentId, /^I_/);
    });

    test("an Action without a binding is rejected", async () => {
      await assert.rejects(
        session.client.request(
          "fetchPostsAction",
          [{ type: "feed" }],
          "missing-user",
        ),
        (error: unknown) => {
          assert.ok(error instanceof ProtocolError);
          assert.match(error.message, /认证/);
          return true;
        },
      );
    });

    test("anonymous fetchPosts requires login", async () => {
      await assert.rejects(
        session.client.request("fetchPostsAction", [{ type: "feed" }], null),
        (error: unknown) => {
          assert.ok(error instanceof ProtocolError);
          assert.match(error.message, /登录/);
          return true;
        },
      );
    });
  });

  describe("http", () => {
    test("GET /api/endpoints returns origins without the application client", async () => {
      const response = await fetch(
        `http://127.0.0.1:${session.port}/api/endpoints`,
      );
      assert.equal(response.ok, true);
      const body = (await response.json()) as { origins: string[] };
      assert.ok(Array.isArray(body.origins));
    });
  });

  describe("auth", () => {
    test("admin PIN login returns a user, token, and administration", () => {
      assert.equal(session.admin.user.handle, "admin");
      assert.equal(session.admin.token.length > 0, true);
      assert.equal(session.admin.user.administration.available, true);
      assert.ok(session.admin.user.administration.roles.includes("root"));
    });

    test("wrong PIN is a domain refusal, not a panic", async () => {
      const result = await session.client.request(
        "loginPinAction",
        ["000000"],
        null,
      );
      assert.deepEqual(result, { error: "密码错误" });
    });

    test("probeAppState after authenticate reports a valid session", async () => {
      const state = await session.client.request(
        "probeAppStateAction",
        [{ touch: true }],
        session.admin.user.id,
      );
      assert.equal(state.session_valid, true);
      assert.equal(state.user?.id, session.admin.user.id);
    });

    test("logout unbinds only that actor", async () => {
      const handle = uniqueHandle();
      const pin = uniquePin();
      const created = await session.client.request(
        "adminCreateUserAction",
        [{ handle, pin, username: handle }],
        session.admin.user.id,
      );
      assert.ok("user" in created);
      const member = await session.login(pin);
      await session.client.request("logoutAction", [], member.user.id);
      await assert.rejects(
        session.client.request(
          "fetchPostsAction",
          [{ type: "feed" }],
          member.user.id,
        ),
        (error: unknown) => error instanceof ProtocolError,
      );
      const feed = await session.client.request(
        "fetchPostsAction",
        [{ type: "feed" }],
        session.admin.user.id,
      );
      assert.ok(Array.isArray(feed.posts));
    });
  });

  describe("groups", () => {
    test("a member can create a group and list it in conversations", async () => {
      const created = await session.client.request(
        "createGroupAction",
        [{ name: "测试群", handle: uniqueHandle("g") }],
        session.admin.user.id,
      );
      assert.equal(created.group.name, "测试群");
      assert.equal(created.group.conv_id, `group:${created.group.id}`);
      const conversations = await session.client.request(
        "fetchConversationsAction",
        [],
        session.admin.user.id,
      );
      assert.ok(
        conversations.entries.some(
          (entry) => entry.conv_id === created.group.conv_id,
        ),
      );
    });

    test("a second member can join a discoverable child of wild", async () => {
      const created = await session.client.request(
        "createGroupAction",
        [
          {
            name: "可见群",
            handle: uniqueHandle("g"),
            discoverable: true,
            parent_group_id: "wild",
          },
        ],
        session.admin.user.id,
      );
      const pin = uniquePin();
      const handle = uniqueHandle();
      await session.client.request(
        "adminCreateUserAction",
        [{ handle, pin, username: handle }],
        session.admin.user.id,
      );
      const member = await session.login(pin);
      const joined = await session.client.request(
        "joinGroupAction",
        [
          {
            groupId: created.group.id,
            source: { type: "search" },
          },
        ],
        member.user.id,
      );
      assert.equal(joined.ok, true);
      if (!joined.ok) return;
      assert.equal(joined.group.id, created.group.id);
    });
  });

  describe("posts", () => {
    test("create, page, edit, tombstone, and revision catch-up stay consistent", async () => {
      const adminId = session.admin.user.id;
      const convId = "group:wild";
      const beforeRevisions = await session.client.request(
        "fetchConversationRevisionsAction",
        [],
        adminId,
      );
      const known =
        beforeRevisions.revisions.find((row) => row.conv_id === convId)
          ?.revision ?? 0;

      const created = await session.client.request(
        "createPostAction",
        [{ conv_id: convId, content: "第一帖" }],
        adminId,
      );
      assert.equal(created.post.type, "text");
      if (created.post.type !== "text") return;
      assert.equal(created.post.text, "第一帖");
      assert.equal(created.post.conv_id, convId);
      assert.ok(created.post.revision > known);
      assert.ok(created.post.sequence >= 1);
      const originalId = created.post.id;
      const originalSequence = created.post.sequence;
      const createdRevision = created.post.revision;

      const page = await session.client.request(
        "fetchPostsAction",
        [{ type: "conversation", conv_id: convId, limit: "20" }],
        adminId,
      );
      assert.ok(page.posts.some((post) => post.id === originalId));
      assert.ok(page.users.some((user) => user.id === adminId));

      const updated = await session.client.request(
        "updatePostAction",
        [{ postId: originalId, text: "已编辑" }],
        adminId,
      );
      assert.equal(updated.post.type, "text");
      if (updated.post.type !== "text") return;
      assert.equal(updated.post.text, "已编辑");
      assert.equal(updated.post.id, originalId);
      assert.equal(updated.post.sequence, originalSequence);
      assert.ok(updated.post.revision > createdRevision);

      const catchUp = await session.client.request(
        "fetchPostsAction",
        [
          {
            type: "conversation",
            conv_id: convId,
            changed_after_revision: createdRevision,
            changed_through_revision: updated.post.revision,
          },
        ],
        adminId,
      );
      const caught = catchUp.posts.find((post) => post.id === originalId);
      assert.equal(caught?.type, "text");
      if (caught?.type !== "text") return;
      assert.equal(caught.text, "已编辑");

      const deleted = await session.client.request(
        "deletePostAction",
        [originalId],
        adminId,
      );
      assert.equal(deleted.post.type, "deleted");
      assert.equal(deleted.post.id, originalId);
      assert.equal(deleted.post.sequence, originalSequence);
      assert.ok(deleted.post.deleted_at);

      const fetched = await session.client.request(
        "fetchPostAction",
        [originalId],
        adminId,
      );
      assert.equal(fetched.post.type, "deleted");
      assert.equal(fetched.post.id, originalId);
    });

    test("a stale catch-up window cannot omit a newer tombstone", async () => {
      const adminId = session.admin.user.id;
      const convId = "group:wild";
      const created = await session.client.request(
        "createPostAction",
        [{ conv_id: convId, content: "待删除" }],
        adminId,
      );
      const startRevision = created.post.revision;
      const removed = await session.client.request(
        "deletePostAction",
        [created.post.id],
        adminId,
      );
      const catchUp = await session.client.request(
        "fetchPostsAction",
        [
          {
            type: "conversation",
            conv_id: convId,
            changed_after_revision: startRevision - 1,
            changed_through_revision: removed.post.revision,
          },
        ],
        adminId,
      );
      const row = catchUp.posts.find((post) => post.id === created.post.id);
      assert.equal(row?.type, "deleted");
    });
  });

  describe("conversations", () => {
    test("read watermark is grow-only when merge is furthest", async () => {
      const adminId = session.admin.user.id;
      const convId = "group:wild";
      const first = await session.client.request(
        "createPostAction",
        [{ conv_id: convId, content: "较早" }],
        adminId,
      );
      const second = await session.client.request(
        "createPostAction",
        [{ conv_id: convId, content: "较晚" }],
        adminId,
      );
      await session.client.request(
        "markConversationReadAction",
        [
          {
            type: "group",
            id: "wild",
            post_id: second.post.id,
            updatedAt: 10,
            merge: "furthest",
          },
        ],
        adminId,
      );
      const backward = await session.client.request(
        "markConversationReadAction",
        [
          {
            type: "group",
            id: "wild",
            post_id: first.post.id,
            updatedAt: 20,
            merge: "furthest",
          },
        ],
        adminId,
      );
      assert.equal(backward.postId, second.post.id);
      assert.equal(backward.sequence, second.post.sequence);
    });

    test("two members of wild can establish a DM with the first post", async () => {
      const pin = uniquePin();
      const handle = uniqueHandle();
      await session.client.request(
        "adminCreateUserAction",
        [{ handle, pin, username: handle }],
        session.admin.user.id,
      );
      const member = await session.login(pin);
      const convId = dmConvId(session.admin.user.id, member.user.id);
      const posted = await session.client.request(
        "createPostAction",
        [{ conv_id: convId, content: "私信" }],
        session.admin.user.id,
      );
      assert.equal(posted.post.conv_id, convId);
      const listed = await session.client.request(
        "fetchConversationsAction",
        [],
        member.user.id,
      );
      assert.ok(listed.entries.some((entry) => entry.conv_id === convId));
    });
  });

  describe("users", () => {
    test("deactivate revokes login but keeps identity history", async () => {
      const pin = uniquePin();
      const handle = uniqueHandle();
      const created = await session.client.request(
        "adminCreateUserAction",
        [{ handle, pin, username: "可停用" }],
        session.admin.user.id,
      );
      assert.ok("user" in created);
      if (!("user" in created)) return;
      const userId = created.user.id;
      const posted = await session.client.request(
        "createPostAction",
        [{ conv_id: "group:wild", content: "停用前的帖" }],
        (await session.login(pin)).user.id,
      );

      await session.client.request(
        "adminMutateUsersAction",
        [{ changes: [{ userId, removal: "deactivate" }] }],
        session.admin.user.id,
      );

      const refused = await session.client.request(
        "loginPinAction",
        [pin],
        null,
      );
      assert.deepEqual(refused, { error: "密码错误" });

      const listed = await session.client.request(
        "adminFetchUsersAction",
        [{ q: handle }],
        session.admin.user.id,
      );
      assert.equal(listed.users.some((user) => user.id === userId), false);

      const remaining = await session.client.request(
        "fetchPostAction",
        [posted.post.id],
        session.admin.user.id,
      );
      assert.equal(remaining.post.type, "text");
      assert.equal(remaining.post.user_id, userId);
    });

    test("purge tombstones posts and removes the identity row", async () => {
      const pin = uniquePin();
      const handle = uniqueHandle();
      const created = await session.client.request(
        "adminCreateUserAction",
        [{ handle, pin, username: "可清除" }],
        session.admin.user.id,
      );
      assert.ok("user" in created);
      if (!("user" in created)) return;
      const userId = created.user.id;
      const member = await session.login(pin);
      const posted = await session.client.request(
        "createPostAction",
        [{ conv_id: "group:wild", content: "清除前的帖" }],
        member.user.id,
      );

      await session.client.request(
        "adminMutateUsersAction",
        [{ changes: [{ userId, removal: "purge" }] }],
        session.admin.user.id,
      );

      const remaining = await session.client.request(
        "fetchPostAction",
        [posted.post.id],
        session.admin.user.id,
      );
      assert.equal(remaining.post.type, "deleted");
      assert.equal(remaining.post.user_id, null);
      assert.equal(remaining.post.id, posted.post.id);
      assert.equal(remaining.post.sequence, posted.post.sequence);
    });
  });

  describe("stickers", () => {
    test("sticker packs are listed without the application client", async () => {
      const packs = await session.client.request(
        "fetchStickerPacksAction",
        [],
        session.admin.user.id,
      );
      assert.ok(packs.packs.length > 0);
    });
  });

  describe("announcement", () => {
    test("announcement payload is readable after login", async () => {
      const announcement = await session.client.request(
        "fetchAnnouncementAction",
        [],
        session.admin.user.id,
      );
      assert.equal(typeof announcement.content, "string");
      assert.equal(typeof announcement.revision, "number");
    });
  });

  describe("app", () => {
    test("getClientMe returns a server-issued client id", async () => {
      const me = await session.client.request(
        "getClientMeAction",
        [],
        session.admin.user.id,
      );
      assert.equal(typeof me.client_id, "string");
      assert.equal(typeof me.ip, "string");
    });
  });
});
