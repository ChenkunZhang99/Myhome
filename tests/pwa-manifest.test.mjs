import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("PWA manifest exposes installable app metadata and complete icon sizes", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  );

  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#163f33");
  assert.ok(manifest.name);
  assert.ok(manifest.short_name);

  const icons = new Map(manifest.icons.map((icon) => [`${icon.sizes}:${icon.purpose}`, icon]));
  assert.equal(icons.get("192x192:any")?.type, "image/png");
  assert.equal(icons.get("512x512:any")?.type, "image/png");
  assert.equal(icons.get("512x512:maskable")?.type, "image/png");

  await Promise.all(manifest.icons.map((icon) => access(new URL(`../public${icon.src}`, import.meta.url))));
  await access(new URL("../public/apple-touch-icon.png", import.meta.url));
});

test("root metadata links the manifest and intentionally avoids private offline caching", async () => {
  const [layout, publicFiles] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    import("node:fs/promises").then(({ readdir }) => readdir(new URL("../public/", import.meta.url))),
  ]);

  assert.match(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.match(layout, /themeColor:\s*"#163f33"/);
  assert.match(layout, /apple:\s*"\/apple-touch-icon\.png"/);
  assert.equal(
    publicFiles.some((name) => /^(service-worker|sw)\.(js|mjs)$/i.test(name)),
    false,
    "authenticated household data must not be cached by an accidental generic service worker",
  );
});
