import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const BASE_URL = process.env.HSP_BASE_URL;
if (!BASE_URL) throw new Error("HSP_BASE_URL is required; run this file through pnpm test:integration");

async function json(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function register(label) {
  const email = `${label}-${randomUUID()}@e2e.test`;
  const { response, body } = await json("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "register", email, password: "Audit-only-password-42" }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "registration must issue a session cookie");
  return { email, cookie: setCookie.split(";", 1)[0] };
}

function authenticated(cookie, init = {}) {
  return {
    ...init,
    headers: { ...init.headers, cookie },
  };
}

test("real HTTP requests enforce authentication and household isolation", async () => {
  const document = await fetch(`${BASE_URL}/`);
  assert.equal(document.status, 200);
  assert.equal(document.headers.get("x-frame-options"), "DENY");
  assert.equal(document.headers.get("x-content-type-options"), "nosniff");
  assert.equal(document.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(document.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(document.headers.get("content-security-policy") ?? "", /object-src 'none'/);

  const anonymous = await json("/api/inventory");
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.response.headers.get("x-frame-options"), "DENY");

  const first = await register("first");
  const firstAuth = await json("/api/auth", authenticated(first.cookie));
  assert.equal(firstAuth.response.status, 200);
  assert.equal(firstAuth.body.signedIn, true);
  assert.equal(firstAuth.body.email, first.email);

  const created = await json(
    "/api/inventory",
    authenticated(first.cookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "integration-isolation-marker",
        category: "测试",
        quantity: 2,
        unit: "件",
        remainingPercent: 75,
      }),
    }),
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const firstItemId = created.body.item.id;
  assert.ok(firstItemId);

  const second = await register("second");
  const secondInventory = await json("/api/inventory", authenticated(second.cookie));
  assert.equal(secondInventory.response.status, 200, JSON.stringify(secondInventory.body));
  assert.equal(
    secondInventory.body.items.some((item) => item.id === firstItemId),
    false,
  );

  const forbiddenPatch = await json(
    "/api/inventory",
    authenticated(second.cookie, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: firstItemId, name: "cross-household-write" }),
    }),
  );
  assert.equal(forbiddenPatch.response.status, 404);

  const forbiddenDelete = await json(
    `/api/inventory?id=${encodeURIComponent(firstItemId)}`,
    authenticated(second.cookie, { method: "DELETE" }),
  );
  assert.equal(forbiddenDelete.response.status, 404);

  const firstInventory = await json("/api/inventory", authenticated(first.cookie));
  assert.equal(firstInventory.response.status, 200, JSON.stringify(firstInventory.body));
  assert.equal(
    firstInventory.body.items.some((item) => item.id === firstItemId),
    true,
  );
});
