#!/usr/bin/env node
import { access } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Bridge } from "./bridge.js";
import { callingThreadId, detectAutomationDirectories, locateAutomation } from "./config.js";
import { publicError } from "./errors.js";
import {
  claudeConfigPath,
  codexConfigPath,
  codexForwardsThreadId,
  connectorRegistration,
  installClaude,
  installCodex,
  readClaudeRegistration,
  readCodexRegistration,
  type Registration,
  sameRegistration,
} from "./install.js";
import { OpenBotClient } from "./openbot.js";
import { createMcpServer, serveStdio } from "./server.js";

const USAGE =
  "Usage: t3-openbot [serve|doctor|install] [--automation-dir PATH] [--codex-config PATH] [--claude-config PATH]\n";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      "automation-dir": { type: "string" },
      "codex-config": { type: "string" },
      "claude-config": { type: "string" },
    },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "serve";
  if (!["serve", "doctor", "install"].includes(command)) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const codex = values["codex-config"] ?? codexConfigPath();
  const claude = values["claude-config"] ?? claudeConfigPath();
  const expected = connectorRegistration();
  if (command === "install") {
    const report = {
      registration: expected,
      codex: { path: codex, outcome: await installCodex(codex, expected) },
      claude: { path: claude, outcome: await installClaude(claude, expected) },
      note: "Provider sessions that are already running keep their old tool list; new T3 threads pick this up.",
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  const explicit = values["automation-dir"];
  const bridge = new Bridge(new OpenBotClient(() => locateAutomation({ explicit })), callingThreadId());
  if (command === "doctor") {
    const report: {
      candidates: string[];
      automationDirectory: string | null;
      source: string | null;
      openbot: { ready: boolean; error?: ReturnType<typeof publicError> };
      agents: { id: string; name: string }[];
      registrations: { codex: RegistrationStatus & { forwardsThreadId: boolean }; claude: RegistrationStatus };
    } = {
      candidates: await detectAutomationDirectories(),
      automationDirectory: null,
      source: null,
      openbot: { ready: false },
      agents: [],
      registrations: {
        codex: {
          ...(await registrationStatus(codex, await readCodexRegistration(codex), expected)),
          forwardsThreadId: await codexForwardsThreadId(codex),
        },
        claude: await registrationStatus(claude, await readClaudeRegistration(claude), expected),
      },
    };
    try {
      const status = await bridge.status();
      report.automationDirectory = status.automationDirectory;
      report.source = status.source;
      report.openbot = { ready: true };
      report.agents = status.agents;
    } catch (error) {
      report.openbot.error = publicError(error);
      process.exitCode = 1;
    }
    const { codex: codexStatus, claude: claudeStatus } = report.registrations;
    if (!codexStatus.current || !codexStatus.forwardsThreadId || !claudeStatus.current) process.exitCode = 1;
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  const server = createMcpServer(bridge);
  const stop = () => void server.close().catch(() => undefined);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await serveStdio(server);
}

interface RegistrationStatus {
  path: string;
  configured: boolean;
  /** The entry launches this build with a Node binary that exists, whichever Node runs doctor. */
  current: boolean;
  commandExists: boolean;
  sameNode: boolean;
  registration: Registration | null;
}

async function registrationStatus(
  path: string,
  found: Registration | null,
  expected: Registration,
): Promise<RegistrationStatus> {
  let commandExists = false;
  if (found) {
    try {
      await access(found.command);
      commandExists = true;
    } catch {
      commandExists = false;
    }
  }
  const sameArgs =
    found !== null && found.args.length === expected.args.length && found.args.every((x, i) => x === expected.args[i]);
  return {
    path,
    configured: found !== null,
    current: sameArgs && commandExists,
    commandExists,
    sameNode: sameRegistration(found, expected),
    registration: found,
  };
}

main().catch((error) => {
  process.stderr.write(JSON.stringify(publicError(error)) + "\n");
  process.exitCode = 1;
});
