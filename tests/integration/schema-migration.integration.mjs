import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const STATE = process.env.HSP_INTEGRATION_STATE;
const WRANGLER = resolve(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const CONFIG = resolve(ROOT, "tests", "integration", "wrangler.jsonc");

if (!STATE) {
  throw new Error("HSP_INTEGRATION_STATE is required; run through pnpm test:integration");
}

async function query(sql) {
  const child = spawn(
    process.execPath,
    [
      WRANGLER,
      "d1",
      "execute",
      "home-stock-planner-integration",
      "--local",
      "--config",
      CONFIG,
      "--persist-to",
      STATE,
      "--command",
      sql,
      "--json",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(STATE, "migration-assert-logs"),
        WRANGLER_SEND_METRICS: "false",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  assert.equal(exitCode, 0, stderr || stdout);
  return JSON.parse(stdout.trim());
}

test("legacy database records exactly one immutable migration baseline", async () => {
  const [result] = await query(
    "SELECT version, name, checksum, LENGTH(checksum) AS checksum_length FROM schema_migrations ORDER BY version",
  );
  assert.deepEqual(result.results, [
    {
      version: 1,
      name: "versioned-migrations-baseline",
      checksum: "1a59b71c16784ed276061d61485286545a28a672976eb74f51900a8bb06a7388",
      checksum_length: 64,
    },
  ]);
});

test("legacy columns are added and backfilled before the baseline is recorded", async () => {
  const [sessionColumns] = await query("PRAGMA table_info(sessions)");
  const sessionColumnNames = sessionColumns.results.map((column) => column.name);
  assert.ok(sessionColumnNames.includes("session_id"));
  assert.ok(sessionColumnNames.includes("last_seen_at"));
  assert.ok(sessionColumnNames.includes("user_agent"));

  const [inventory] = await query(
    "SELECT remaining_percent, household_id FROM inventory_items WHERE id = 'legacy-empty-item'",
  );
  assert.deepEqual(inventory.results, [{ remaining_percent: 0, household_id: "household-default" }]);

  const [membership] = await query(
    "SELECT role FROM household_memberships WHERE user_id = 'legacy-user' AND household_id = 'household-default'",
  );
  assert.deepEqual(membership.results, [{ role: "owner" }]);
});

test("legacy tables and store columns are removed by the existing compatibility pass", async () => {
  const [tables] = await query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('stores', 'recipe_suggestions', 'recipe_favorites') ORDER BY name",
  );
  assert.deepEqual(tables.results, []);

  for (const table of ["flyer_deals", "flyer_price_history", "flyer_recommendation_feedback"]) {
    const [columns] = await query(`PRAGMA table_info(${table})`);
    const names = columns.results.map((column) => column.name);
    assert.equal(names.includes("store_id"), false, table);
    assert.equal(names.includes("source_key"), true, table);
  }
});
