import assert from "node:assert/strict";
import test from "node:test";
import { contentSecurityPolicy, withSecurityHeaders } from "../worker/securityHeaders.ts";

test("production CSP excludes development-only capabilities", () => {
  const policy = contentSecurityPolicy(new Request("https://example.com/inventory"));
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /connect-src[^;]*\bws:/);
});

test("localhost CSP permits Vite HMR without weakening production", () => {
  const policy = contentSecurityPolicy(new Request("http://127.0.0.1:3000/"));
  assert.match(policy, /unsafe-eval/);
  assert.match(policy, /connect-src[^;]*\bws:/);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
});

test("security wrapper preserves the response and replaces weak headers", async () => {
  const original = new Response("ok", {
    status: 201,
    headers: { "x-frame-options": "SAMEORIGIN", "set-cookie": "session=value" },
  });
  const secured = withSecurityHeaders(original, new Request("https://example.com/api/test"));

  assert.equal(secured.status, 201);
  assert.equal(await secured.text(), "ok");
  assert.equal(secured.headers.get("set-cookie"), "session=value");
  assert.equal(secured.headers.get("x-frame-options"), "DENY");
  assert.equal(secured.headers.get("x-content-type-options"), "nosniff");
  assert.equal(secured.headers.get("strict-transport-security"), "max-age=31536000");
});
