import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const VINEXT_CLI = resolve(ROOT, "node_modules", "vinext", "dist", "cli.js");
const WRANGLER_CLI = resolve(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const CONFIG = resolve(ROOT, "tests", "integration", "wrangler.jsonc");
const FIXTURE = resolve(ROOT, "tests", "integration", "legacy-schema.sql");
const TEST_FILE = resolve(ROOT, "tests", "integration", "schema-migration.integration.mjs");
const GUARD_TEST_FILE = resolve(ROOT, "tests", "integration", "schema-migration-guard.integration.mjs");
const KEEP_STATE = process.env.HSP_KEEP_INTEGRATION_STATE === "1";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  if (!port) throw new Error("Could not allocate a migration-test port");
  return port;
}

function tail(text, size = 12_000) {
  return text.length <= size ? text : text.slice(-size);
}

async function runChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    windowsHide: true,
    ...options,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr].filter(Boolean)) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (output = tail(output + chunk)));
  }
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(output || `Child process exited with ${exitCode}`);
  return output;
}

async function seedLegacyDatabase(stateDirectory) {
  await runChild(
    process.execPath,
    [
      WRANGLER_CLI,
      "d1",
      "execute",
      "home-stock-planner-integration",
      "--local",
      "--config",
      CONFIG,
      "--persist-to",
      stateDirectory,
      "--file",
      FIXTURE,
    ],
    {
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(stateDirectory, "seed-logs"),
        WRANGLER_SEND_METRICS: "false",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function insertUnknownMigration(stateDirectory) {
  await runChild(
    process.execPath,
    [
      WRANGLER_CLI,
      "d1",
      "execute",
      "home-stock-planner-integration",
      "--local",
      "--config",
      CONFIG,
      "--persist-to",
      stateDirectory,
      "--command",
      "INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future-test', 'future-test')",
    ],
    {
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(stateDirectory, "future-version-logs"),
        WRANGLER_SEND_METRICS: "false",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function startServer(port, stateDirectory) {
  const output = { value: "" };
  const child = spawn(
    process.execPath,
    [VINEXT_CLI, "dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HSP_INTEGRATION_TEST: "1",
        HSP_INTEGRATION_STATE: stateDirectory,
        WRANGLER_LOG_PATH: join(stateDirectory, "wrangler-logs"),
        MINIFLARE_REGISTRY_PATH: join(stateDirectory, "registry"),
        WRANGLER_SEND_METRICS: "false",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (output.value = tail(output.value + chunk)));
  }
  return { child, output };
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Migration server exited with code ${child.exitCode}.\n${tail(output.value)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/auth`, { signal: AbortSignal.timeout(1_500) });
      if (response.status < 500) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Migration server did not become ready within 45 seconds.\n${tail(output.value)}`);
}

async function stopOwnedProcess(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolveStop) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", resolveStop);
      killer.once("error", resolveStop);
    });
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveStop) => child.once("close", resolveStop)),
    new Promise((resolveStop) => setTimeout(resolveStop, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function triggerSchemaOnFreshIsolate(stateDirectory) {
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, output } = startServer(port, stateDirectory);
  try {
    await waitForServer(baseUrl, child, output);
    const response = await fetch(`${baseUrl}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "signOut" }),
    });
    if (response.status >= 500) {
      throw new Error(`Schema trigger failed with ${response.status}.\n${tail(output.value)}`);
    }
    await response.arrayBuffer();
  } finally {
    await stopOwnedProcess(child);
  }
}

async function verifyUnknownVersionFailsClosed(stateDirectory) {
  await insertUnknownMigration(stateDirectory);
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, output } = startServer(port, stateDirectory);
  try {
    await waitForServer(baseUrl, child, output);
    return await new Promise((resolveExit, reject) => {
      const tests = spawn(process.execPath, ["--test", GUARD_TEST_FILE], {
        cwd: ROOT,
        env: { ...process.env, HSP_BASE_URL: baseUrl, NO_COLOR: "1" },
        stdio: "inherit",
        windowsHide: true,
      });
      tests.once("error", reject);
      tests.once("close", (code) => resolveExit(code ?? 1));
    });
  } finally {
    await stopOwnedProcess(child);
  }
}

const stateDirectory = await mkdtemp(join(tmpdir(), "hsp-migration-integration-"));
let exitCode = 1;
try {
  await seedLegacyDatabase(stateDirectory);
  // The second cold start proves the recorded baseline is safe to encounter again.
  await triggerSchemaOnFreshIsolate(stateDirectory);
  await triggerSchemaOnFreshIsolate(stateDirectory);

  exitCode = await new Promise((resolveExit, reject) => {
    const tests = spawn(process.execPath, ["--test", TEST_FILE], {
      cwd: ROOT,
      env: {
        ...process.env,
        HSP_INTEGRATION_STATE: stateDirectory,
        NO_COLOR: "1",
      },
      stdio: "inherit",
      windowsHide: true,
    });
    tests.once("error", reject);
    tests.once("close", (code) => resolveExit(code ?? 1));
  });
  if (exitCode === 0) exitCode = await verifyUnknownVersionFailsClosed(stateDirectory);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  if (KEEP_STATE) {
    process.stdout.write(`Migration integration state kept at ${stateDirectory}\n`);
  } else {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

process.exitCode = exitCode;
