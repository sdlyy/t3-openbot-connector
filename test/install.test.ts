import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  codexBlock,
  installClaude,
  installCodex,
  readClaudeRegistration,
  readCodexRegistration,
  type Registration,
} from "../src/install.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = promisify(execFile);
const registration: Registration = { command: "/opt/node versions/bin/node", args: ["/srv/t3 \"quoted\"/cli.js"] };

async function root(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "t3-openbot-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("replaces only its own Codex tables and keeps the rest", async (t) => {
  const path = join(await root(t), "config.toml");
  await writeFile(
    path,
    [
      'model = "gpt-5"',
      "",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      "",
      "[mcp_servers.t3_openbot]",
      'url = "http://127.0.0.1:4319/mcp"',
      'http_headers = { Authorization = "Bearer old" }',
      "",
      "[mcp_servers.t3_openbot.env]",
      'X = "1"',
      "",
      "[mcp_servers.kibana]",
      'command = "node"',
      "",
    ].join("\n"),
  );
  assert.equal(await installCodex(path, registration), "updated");
  const content = await readFile(path, "utf8");
  assert.equal(
    content,
    [
      'model = "gpt-5"',
      "",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      "",
      ...codexBlock(registration).split("\n").slice(0, -1),
      "",
      "[mcp_servers.kibana]",
      'command = "node"',
      "",
    ].join("\n"),
  );
  assert.ok(!content.includes("Bearer old"));
  assert.deepEqual(await readCodexRegistration(path), registration);
  assert.equal(await installCodex(path, registration), "unchanged");
});

test("appends to a Codex config without its table and creates a missing one", async (t) => {
  const base = await root(t);
  const existing = join(base, "config.toml");
  await writeFile(existing, 'model = "gpt-5"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n');
  assert.equal(await installCodex(existing, registration), "updated");
  assert.equal(
    await readFile(existing, "utf8"),
    'model = "gpt-5"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n\n' + codexBlock(registration),
  );
  const fresh = join(base, "nested", "config.toml");
  assert.equal(await installCodex(fresh, registration), "created");
  assert.equal(await readFile(fresh, "utf8"), codexBlock(registration));
  assert.deepEqual(await readCodexRegistration(fresh), registration);
});

test("adds its Claude entry beside other keys and servers", async (t) => {
  const path = join(await root(t), ".claude.json");
  await writeFile(path, JSON.stringify({ numStartups: 3, mcpServers: { kibana: { type: "stdio", command: "node" } } }));
  assert.equal(await installClaude(path, registration), "updated");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(parsed.numStartups, 3);
  assert.equal(parsed.mcpServers.kibana.command, "node");
  assert.deepEqual(parsed.mcpServers.t3_openbot, { type: "stdio", ...registration, env: {} });
  assert.deepEqual(await readClaudeRegistration(path), registration);
  assert.equal(await installClaude(path, registration), "unchanged");
  const fresh = join(await root(t), ".claude.json");
  assert.equal(await installClaude(fresh, registration), "created");
  assert.deepEqual(await readClaudeRegistration(fresh), registration);
});

test("the install command registers this checkout and doctor confirms it", async (t) => {
  const base = await root(t);
  const codex = join(base, "config.toml");
  const claude = join(base, ".claude.json");
  const installed = JSON.parse(
    (await run(process.execPath, [cli, "install", "--codex-config", codex, "--claude-config", claude])).stdout,
  );
  assert.equal(installed.codex.outcome, "created");
  assert.equal(installed.claude.outcome, "created");
  assert.deepEqual(installed.registration.args, [cli]);
  const doctor = await run(process.execPath, [
    cli,
    "doctor",
    "--automation-dir",
    join(base, "none"),
    "--codex-config",
    codex,
    "--claude-config",
    claude,
  ]).catch((error: { stdout: string }) => error);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.registrations.codex.current, true);
  assert.equal(report.registrations.codex.forwardsThreadId, true);
  assert.equal(report.registrations.claude.current, true);
  assert.equal(report.openbot.error.code, "openbot_offline");
  const again = JSON.parse(
    (await run(process.execPath, [cli, "install", "--codex-config", codex, "--claude-config", claude])).stdout,
  );
  assert.equal(again.codex.outcome, "unchanged");
  assert.equal(again.claude.outcome, "unchanged");
});
