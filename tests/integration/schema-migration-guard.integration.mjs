import assert from "node:assert/strict";
import test from "node:test";

const BASE_URL = process.env.HSP_BASE_URL;
if (!BASE_URL) throw new Error("HSP_BASE_URL is required; run through pnpm test:integration");

test("an application older than the database fails closed without leaking schema details", async () => {
  const response = await fetch(`${BASE_URL}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "signOut" }),
  });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: "登录暂时不可用" });
  assert.doesNotMatch(JSON.stringify(body), /schema|migration|version|checksum|99/i);
});
