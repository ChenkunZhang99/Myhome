import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const VINEXT_CLI = resolve(ROOT, "node_modules", "vinext", "dist", "cli.js");
const TEST_FILE = resolve(ROOT, "tests", "integration", "auth-household.integration.mjs");
const MIGRATION_RUNNER = resolve(ROOT, "scripts", "run-schema-migration-tests.mjs");
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
  if (!port) throw new Error("Could not allocate an integration-test port");
  return port;
}

function tail(text, size = 12_000) {
  return text.length <= size ? text : text.slice(-size);
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Integration server exited with code ${child.exitCode}.\n${tail(output.value)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/auth`, { signal: AbortSignal.timeout(1_500) });
      if (response.status < 500) return;
    } catch {
      // Vite is still starting. Try again until the bounded deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Integration server did not become ready within 45 seconds.\n${tail(output.value)}`);
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

const port = await unusedPort();
const baseUrl = `http://127.0.0.1:${port}`;
const stateDirectory = await mkdtemp(join(tmpdir(), "hsp-integration-"));
const output = { value: "" };

const server = spawn(
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

for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output.value = tail(output.value + chunk);
  });
}

let testExitCode = 1;
try {
  await waitForServer(baseUrl, server, output);
  testExitCode = await new Promise((resolveCode, reject) => {
    const tests = spawn(process.execPath, ["--test", TEST_FILE], {
      cwd: ROOT,
      env: { ...process.env, HSP_BASE_URL: baseUrl, NO_COLOR: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    tests.once("error", reject);
    tests.once("close", (code) => resolveCode(code ?? 1));
  });
  if (testExitCode !== 0) {
    process.stderr.write(`\nIntegration server output:\n${tail(output.value)}\n`);
  }
} finally {
  await stopOwnedProcess(server);
  if (KEEP_STATE) {
    process.stdout.write(`Integration state kept at ${stateDirectory}\n`);
  } else {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

if (testExitCode === 0) {
  testExitCode = await new Promise((resolveCode, reject) => {
    const migrationTests = spawn(process.execPath, [MIGRATION_RUNNER], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    migrationTests.once("error", reject);
    migrationTests.once("close", (code) => resolveCode(code ?? 1));
  });
}

process.exitCode = testExitCode;
