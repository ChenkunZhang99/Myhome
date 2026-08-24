import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const BASE_URL = process.env.HSP_BASE_URL;
const PASSWORD = "Audit-only-password-42";
if (!BASE_URL) throw new Error("HSP_BASE_URL is required; run this file through pnpm test:integration");

async function json(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const body = await response.json();
  return { response, body };
}

function cookieFrom(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "response must issue a session cookie");
  return setCookie.split(";", 1)[0];
}

async function register(label, userAgent = "HSP integration registration") {
  const email = `${label}-${randomUUID()}@e2e.test`;
  const { response, body } = await json("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ action: "register", email, password: PASSWORD }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return { email, cookie: cookieFrom(response) };
}

async function signIn(email, password, userAgent) {
  const { response, body } = await json("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ action: "password", email, password }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return cookieFrom(response);
}

function authenticated(cookie, init = {}) {
  return {
    ...init,
    headers: { ...init.headers, cookie },
  };
}

test("PWA manifest and install icons are served over real HTTP", async () => {
  const documentResponse = await fetch(`${BASE_URL}/`);
  const document = await documentResponse.text();
  assert.match(document, /<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/);
  assert.match(document, /<link[^>]+rel="apple-touch-icon"[^>]+href="\/apple-touch-icon\.png"/);
  assert.match(document, /<meta[^>]+name="theme-color"[^>]+content="#163f33"/);

  const manifestResponse = await fetch(`${BASE_URL}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.match(
    manifestResponse.headers.get("content-type") ?? "",
    /application\/manifest\+json|application\/json/,
  );
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, "standalone");

  for (const icon of manifest.icons) {
    const iconResponse = await fetch(`${BASE_URL}${icon.src}`);
    assert.equal(iconResponse.status, 200, icon.src);
    assert.match(iconResponse.headers.get("content-type") ?? "", /^image\/png/i, icon.src);
    const png = Buffer.from(await iconResponse.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", icon.src);
    const [expectedWidth, expectedHeight] = icon.sizes.split("x").map(Number);
    assert.equal(png.readUInt32BE(16), expectedWidth, icon.src);
    assert.equal(png.readUInt32BE(20), expectedHeight, icon.src);
  }
});

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

test("password changes rotate sessions and users can revoke devices", async () => {
  const owner = await register("sessions", "Audit Browser A / Windows");
  const secondCookie = await signIn(owner.email, PASSWORD, "Audit Browser B / Android");

  const listed = await json("/api/sessions", authenticated(owner.cookie));
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.sessions.length, 2);
  assert.equal(listed.body.sessions.filter((session) => session.current).length, 1);
  const secondSession = listed.body.sessions.find((session) => session.userAgent.includes("Audit Browser B"));
  assert.ok(secondSession);
  assert.equal(secondSession.current, false);

  const revoked = await json(
    "/api/sessions",
    authenticated(owner.cookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "revoke", sessionId: secondSession.id }),
    }),
  );
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
  const secondAfterRevoke = await json("/api/auth", authenticated(secondCookie, { method: "PATCH" }));
  assert.equal(secondAfterRevoke.body.valid, false);

  const thirdCookie = await signIn(owner.email, PASSWORD, "Audit Browser C / iPhone");
  const changed = await json(
    "/api/auth",
    authenticated(owner.cookie, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Audit Browser Rotated / Mac" },
      body: JSON.stringify({ action: "setPassword", password: "Audit-new-password-84" }),
    }),
  );
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  const rotatedCookie = cookieFrom(changed.response);

  const oldCurrent = await json("/api/auth", authenticated(owner.cookie, { method: "PATCH" }));
  const oldOther = await json("/api/auth", authenticated(thirdCookie, { method: "PATCH" }));
  const newCurrent = await json("/api/auth", authenticated(rotatedCookie, { method: "PATCH" }));
  assert.equal(oldCurrent.body.valid, false);
  assert.equal(oldOther.body.valid, false);
  assert.equal(newCurrent.body.valid, true);

  const afterRotation = await json("/api/sessions", authenticated(rotatedCookie));
  assert.equal(afterRotation.body.sessions.length, 1);
  assert.equal(afterRotation.body.sessions[0].current, true);
  assert.match(afterRotation.body.sessions[0].userAgent, /Rotated/);

  const otherCookie = await signIn(owner.email, "Audit-new-password-84", "Audit Browser D / Android");
  const revokeOthers = await json(
    "/api/sessions",
    authenticated(rotatedCookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "revokeOthers" }),
    }),
  );
  assert.equal(revokeOthers.response.status, 200, JSON.stringify(revokeOthers.body));
  const otherAfterRevoke = await json("/api/auth", authenticated(otherCookie, { method: "PATCH" }));
  assert.equal(otherAfterRevoke.body.valid, false);

  const lastOtherCookie = await signIn(owner.email, "Audit-new-password-84", "Audit Browser E / Windows");
  const revokeAll = await json(
    "/api/sessions",
    authenticated(rotatedCookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "revokeAll" }),
    }),
  );
  assert.equal(revokeAll.response.status, 200, JSON.stringify(revokeAll.body));
  assert.match(revokeAll.response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  const currentAfterAll = await json("/api/auth", authenticated(rotatedCookie, { method: "PATCH" }));
  const otherAfterAll = await json("/api/auth", authenticated(lastOtherCookie, { method: "PATCH" }));
  assert.equal(currentAfterAll.body.valid, false);
  assert.equal(otherAfterAll.body.valid, false);
});
