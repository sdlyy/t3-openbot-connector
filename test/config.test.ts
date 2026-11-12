import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { detectAutomationDirectories, locateAutomation } from "../src/config.js";
import { BridgeError } from "../src/errors.js";

async function root(t: TestContext, profiles: Record<string, boolean>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "t3-openbot-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, publishing] of Object.entries(profiles)) {
    await mkdir(join(directory, name, "automation"), { recursive: true });
    if (publishing) await writeFile(join(directory, name, "automation", "url"), "http://127.0.0.1:1\n");
  }
  return directory;
}

async function code(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof BridgeError) return error.code;
    throw error;
  }
  throw new Error("The operation did not fail.");
}

test("detects only OpenBot profiles that publish files", async (t) => {
  const base = await root(t, { OpenBot: true, "OpenBot Dev wt-abc": false, Other: true });
  assert.deepEqual(await detectAutomationDirectories([base, join(base, "missing")]), [join(base, "OpenBot", "automation")]);
  const located = await locateAutomation({ roots: [base], env: {} });
  assert.deepEqual(located, { directory: join(base, "OpenBot", "automation"), source: "detected" });
});

test("absence and ambiguity are explicit", async (t) => {
  const none = await root(t, { OpenBot: false });
  assert.equal(await code(locateAutomation({ roots: [none], env: {} })), "openbot_offline");
  const several = await root(t, { OpenBot: true, "OpenBot Dev wt-abc": true });
  assert.equal(await code(locateAutomation({ roots: [several], env: {} })), "openbot_profile_ambiguous");
});

test("a flag or the environment overrides detection", async (t) => {
  const several = await root(t, { OpenBot: true, "OpenBot Dev wt-abc": true });
  assert.deepEqual(await locateAutomation({ explicit: "chosen", roots: [several], env: {} }), {
    directory: resolve("chosen"),
    source: "flag",
  });
  assert.deepEqual(await locateAutomation({ roots: [several], env: { OPENBOT_AUTOMATION_DIR: "/tmp/x" } }), {
    directory: resolve("/tmp/x"),
    source: "environment",
  });
});
