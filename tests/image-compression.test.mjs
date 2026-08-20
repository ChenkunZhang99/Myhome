import assert from "node:assert/strict";
import test from "node:test";
import { compressImage, formatBytes } from "../app/imageCompression.ts";

function fakeFile(size, type = "image/jpeg", name = "receipt.jpg") {
  return new File([new Uint8Array(size)], name, { type });
}

test("leaves a photo alone when it is already small enough", async () => {
  const small = fakeFile(400 * 1024);
  const result = await compressImage(small);
  assert.equal(result.compressed, false);
  assert.equal(result.file, small);
  assert.equal(result.originalSize, small.size);
});

test("never runs a GIF through canvas, because that would drop the animation", async () => {
  const gif = fakeFile(3 * 1024 * 1024, "image/gif", "receipt.gif");
  const result = await compressImage(gif);
  assert.equal(result.compressed, false);
  assert.equal(result.file, gif);
});

test("passes non-images straight through", async () => {
  const pdf = fakeFile(3 * 1024 * 1024, "application/pdf", "receipt.pdf");
  const result = await compressImage(pdf);
  assert.equal(result.compressed, false);
});

test("falls back to the original when the browser cannot decode the image", async () => {
  // Node 里没有 createImageBitmap / document，正好覆盖「解不出来就原样上传」这条路径。
  const big = fakeFile(3 * 1024 * 1024);
  const result = await compressImage(big);
  assert.equal(result.compressed, false);
  assert.equal(result.originalSize, big.size);
});

test("respects a custom size budget", async () => {
  const file = fakeFile(700 * 1024);
  assert.equal((await compressImage(file, 1024 * 1024)).compressed, false);
  // 预算调低到 500KB 后它就不再算「已经够小」，会尝试压缩（此环境下压不了，退回原图）
  assert.equal((await compressImage(file, 500 * 1024)).originalSize, file.size);
});

test("formats sizes the way the upload box shows them", () => {
  assert.equal(formatBytes(512), "1 KB");
  assert.equal(formatBytes(280 * 1024), "280 KB");
  assert.equal(formatBytes(3.25 * 1024 * 1024), "3.3 MB");
});
