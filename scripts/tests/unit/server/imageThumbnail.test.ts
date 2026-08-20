import assert from "node:assert/strict";
import test from "node:test";
import jpegJs from "jpeg-js";
import { PNG } from "pngjs";
import {
  canRenderPostImageThumbnail,
  detectPostImageMime,
  inspectPostImage,
  renderPostImageThumbnail,
  THUMBNAIL_MAX_EDGE,
} from "@/server/infra/imageThumbnail";

function jpegBytes(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 40;
    data[i + 2] = 40;
    data[i + 3] = 255;
  }
  const encoded = jpegJs.encode({ data, width, height }, 80);
  return encoded.data instanceof Uint8Array
    ? encoded.data
    : new Uint8Array(encoded.data);
}

function pngBytes(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 20;
    png.data[i + 1] = 180;
    png.data[i + 2] = 80;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test("detects jpeg, png, gif, and webp magic", () => {
  assert.equal(detectPostImageMime(jpegBytes(8, 8)), "image/jpeg");
  assert.equal(detectPostImageMime(pngBytes(4, 4)), "image/png");
  const gif = Buffer.from(
    "474946383961010001000000002c00000000010001000002024c01003b",
    "hex",
  );
  assert.equal(detectPostImageMime(gif), "image/gif");
  const webp = Buffer.alloc(16);
  webp.write("RIFF", 0);
  webp.write("WEBP", 8);
  assert.equal(detectPostImageMime(webp), "image/webp");
  assert.equal(detectPostImageMime(Buffer.from("not-an-image")), null);
});

test("inspects jpeg and png dimensions without decoding the full raster twice", () => {
  const jpeg = inspectPostImage(jpegBytes(48, 32));
  assert.equal(jpeg.mime, "image/jpeg");
  assert.equal(jpeg.width, 48);
  assert.equal(jpeg.height, 32);
  const png = inspectPostImage(pngBytes(12, 9));
  assert.equal(png.mime, "image/png");
  assert.equal(png.width, 12);
  assert.equal(png.height, 9);
});

test("renders a jpeg thumbnail whose longest edge is at most 320", () => {
  const original = jpegBytes(400, 200);
  const thumb = renderPostImageThumbnail(original);
  assert.equal(thumb.mime, "image/jpeg");
  assert.equal(thumb.width, THUMBNAIL_MAX_EDGE);
  assert.equal(thumb.height, THUMBNAIL_MAX_EDGE / 2);
  assert.equal(detectPostImageMime(thumb.bytes), "image/jpeg");
  assert.ok(thumb.bytes.byteLength > 0);
  assert.ok(thumb.bytes.byteLength < original.byteLength);
});

test("keeps already-small images inside the thumbnail bound", () => {
  const thumb = renderPostImageThumbnail(pngBytes(40, 30));
  assert.equal(thumb.width, 40);
  assert.equal(thumb.height, 30);
  assert.equal(canRenderPostImageThumbnail("image/png"), true);
  assert.equal(canRenderPostImageThumbnail("image/webp"), false);
});
