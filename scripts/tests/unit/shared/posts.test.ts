import assert from "node:assert/strict";
import test from "node:test";
import { articleBrief, imageBrief, stickerBrief } from "@/shared/posts/brief";

test("post briefs keep a stable Chinese prefix", () => {
  assert.equal(stickerBrief("smile"), "[贴纸] smile");
  assert.equal(articleBrief("几何"), "[文章] 几何");
  assert.equal(imageBrief(), "[图片]");
});
