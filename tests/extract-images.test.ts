/**
 * Tests for extractImagePaths — extracting local image file references from
 * agent reply text so the bridge can forward them as WeChat image messages.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { extractImagePaths } from "../src/weixin/send.js";

const BASE = process.platform === "win32" ? "C:\\proj" : "/proj";

test("markdown image syntax with relative path is resolved against baseDir", () => {
  const text = "Here is the chart:\n\n![sine wave](sine.png)\n\nHope it helps.";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].absPath, path.resolve(BASE, "sine.png"));
  assert.equal(imgs[0].rawMatch, "![sine wave](sine.png)");
});

test("markdown image with file:// URL is parsed correctly", () => {
  const fileUrl = process.platform === "win32"
    ? "file:///C:/proj/out.png"
    : "file:///proj/out.png";
  const expected = process.platform === "win32" ? "C:/proj/out.png" : "/proj/out.png";
  const text = `Result: ![](${fileUrl})`;

  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  // path.resolve normalizes separators; compare via normalization
  assert.equal(path.resolve(imgs[0].absPath), path.resolve(expected));
});

test("bare file:// URL (not in markdown) is extracted", () => {
  const fileUrl = process.platform === "win32"
    ? "file:///C:/proj/diagram.png"
    : "file:///proj/diagram.png";
  const expected = process.platform === "win32" ? "C:/proj/diagram.png" : "/proj/diagram.png";
  const text = `Generated at ${fileUrl} — please review.`;

  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  assert.equal(path.resolve(imgs[0].absPath), path.resolve(expected));
  assert.equal(imgs[0].rawMatch, fileUrl);
});

test("absolute path with image extension is extracted", () => {
  const abs = process.platform === "win32"
    ? "C:\\proj\\build\\chart.png"
    : "/proj/build/chart.png";
  const text = `Saved to ${abs}`;

  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].absPath, path.resolve(abs));
});

test("relative path starting with ./ is extracted", () => {
  const text = "Output: ./output/plot.png is ready.";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].absPath, path.resolve(BASE, "output/plot.png"));
});

test("non-image file extensions are ignored", () => {
  const text = "See ![doc](readme.md) and ![code](main.ts).";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 0, "non-image extensions must not be extracted");
});

test("plain text without paths returns empty array", () => {
  const text = "I generated the sine wave plot successfully. The file is saved.";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 0);
});

test("duplicate path references are deduplicated", () => {
  const text = "![a](sine.png) and again ![b](sine.png)";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1, "same path referenced twice must yield one entry");
});

test("multiple distinct images are all extracted in order", () => {
  const text = "![first](a.png) then ![second](sub/b.png) and ![third](c.png)";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 3);
  assert.equal(imgs[0].absPath, path.resolve(BASE, "a.png"));
  assert.equal(imgs[1].absPath, path.resolve(BASE, "sub/b.png"));
  assert.equal(imgs[2].absPath, path.resolve(BASE, "c.png"));
});

test("all supported image extensions are recognized", () => {
  const exts = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
  for (const ext of exts) {
    const text = `![](${ext}.${ext})`;
    const imgs = extractImagePaths(text, BASE);
    assert.equal(imgs.length, 1, `.${ext} must be recognized as an image`);
  }
});

test("quoted path in markdown is handled", () => {
  const text = '![alt]("quoted.png")';
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].absPath, path.resolve(BASE, "quoted.png"));
});

test("Unix absolute path is extracted (not just Windows drive paths)", () => {
  // Regardless of host platform, a leading-slash Unix-style path with an
  // image extension must be matched by the bare-path fallback. On Windows,
  // path.isAbsolute("/home/u/img.png") is true so the path is returned
  // as-is; on Unix it stays absolute. Compare via path.resolve to normalize.
  const text = "Saved to /home/u/img.png for review.";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  assert.equal(path.resolve(imgs[0].absPath), path.resolve("/home/u/img.png"));
});

test("trailing punctuation after bare path is stripped", () => {
  // Sentence-ending period must not be swallowed into the path, otherwise
  // ext() would return "." and the image would be missed.
  const text = "Generated ./out/plot.png.";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].absPath, path.resolve(BASE, "out/plot.png"));
});

test("trailing comma and closing paren after bare path are stripped", () => {
  const text = "See /tmp/a.png, and also /tmp/b.png).";
  const imgs = extractImagePaths(text, BASE);

  assert.equal(imgs.length, 2);
  // Compare via path.resolve to normalize across platforms (on Windows,
  // "/tmp/a.png" stays as-is from isAbsolute but resolves to "C:\tmp\a.png").
  assert.equal(path.resolve(imgs[0].absPath), path.resolve("/tmp/a.png"));
  assert.equal(path.resolve(imgs[1].absPath), path.resolve("/tmp/b.png"));
});
