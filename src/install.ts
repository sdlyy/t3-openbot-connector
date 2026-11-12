import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "t3_openbot";
const THREAD_VARIABLE = "T3CODE_THREAD_ID";

export interface Registration {
  command: string;
  args: string[];
}

export type InstallOutcome = "created" | "updated" | "unchanged";

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

export function claudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

/** The Node binary that runs this process, resolved past version-manager shims, and this CLI's built entry. */
export function connectorRegistration(): Registration {
  return {
    command: realpathSync(process.execPath),
    args: [fileURLToPath(new URL("./cli.js", import.meta.url))],
  };
}

export function sameRegistration(a: Registration | null, b: Registration): boolean {
  return a !== null && a.command === b.command && a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);
}

function tomlString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function fromTomlString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function codexBlock(registration: Registration): string {
  return (
    "[mcp_servers." +
    SERVER_NAME +
    "]\n" +
    "command = " +
    tomlString(registration.command) +
    "\n" +
    "args = [" +
    registration.args.map(tomlString).join(", ") +
    "]\n" +
    // Codex gives MCP servers a reduced environment; the thread ID is how reports find their way back.
    'env_vars = ["' +
    THREAD_VARIABLE +
    '"]\n'
  );
}

const OURS = new RegExp("^\\s*\\[mcp_servers\\." + SERVER_NAME + "(?:\\.[^\\]]*)?\\]\\s*$");
const HEADER = /^\s*\[/;

/** Splits a TOML file into the lines that belong to our server tables and the rest, keeping the rest in order. */
function splitCodex(content: string): { kept: string[]; ours: string[]; insertAt: number | null } {
  const kept: string[] = [];
  const ours: string[] = [];
  let inOurs = false;
  let insertAt: number | null = null;
  for (const line of content.split("\n")) {
    if (HEADER.test(line)) {
      inOurs = OURS.test(line);
      if (inOurs && insertAt === null) insertAt = kept.length;
    }
    (inOurs ? ours : kept).push(line);
  }
  return { kept, ours, insertAt };
}

export async function readCodexRegistration(path: string): Promise<Registration | null> {
  const content = await readOrEmpty(path);
  const { ours } = splitCodex(content);
  const command = ours.map((line) => /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line)).find(Boolean);
  const args = ours.map((line) => /^\s*args\s*=\s*\[(.*)\]\s*$/.exec(line)).find(Boolean);
  if (!command?.[1] || !args) return null;
  const items = Array.from((args[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g), (match) => fromTomlString(match[1] ?? ""));
  return { command: fromTomlString(command[1]), args: items };
}

export async function codexForwardsThreadId(path: string): Promise<boolean> {
  const { ours } = splitCodex(await readOrEmpty(path));
  return ours.some((line) => /^\s*env_vars\s*=/.test(line) && line.includes('"' + THREAD_VARIABLE + '"'));
}

export async function installCodex(path: string, registration: Registration): Promise<InstallOutcome> {
  const content = await readOrEmpty(path);
  const existed = content !== "" || (await exists(path));
  const { kept, insertAt } = splitCodex(content);
  const block = codexBlock(registration).split("\n");
  block.pop();
  let lines: string[];
  if (insertAt !== null) {
    // Blank lines inside the old block were dropped with it; keep the next table separated.
    const after = kept.slice(insertAt);
    const gap = after.length > 0 && after[0]?.trim() !== "" ? [""] : [];
    lines = [...kept.slice(0, insertAt), ...block, ...gap, ...after];
  } else {
    const body = kept.join("\n").replace(/\n*$/, "");
    lines = [...(body === "" ? [] : [body, ""]), ...block];
  }
  const next = lines.join("\n").replace(/\n*$/, "\n");
  if (next === content) return "unchanged";
  await writePrivately(path, next);
  return existed ? "updated" : "created";
}

export async function readClaudeRegistration(path: string): Promise<Registration | null> {
  const parsed = await readJson(path);
  const servers = parsed.mcpServers;
  if (!isRecord(servers)) return null;
  const entry = servers[SERVER_NAME];
  if (!isRecord(entry) || typeof entry.command !== "string" || !Array.isArray(entry.args)) return null;
  return { command: entry.command, args: entry.args.filter((x): x is string => typeof x === "string") };
}

export async function installClaude(path: string, registration: Registration): Promise<InstallOutcome> {
  const existed = await exists(path);
  const parsed = await readJson(path);
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const current = servers[SERVER_NAME];
  const entry = { type: "stdio", command: registration.command, args: registration.args, env: {} };
  if (JSON.stringify(current) === JSON.stringify(entry)) return "unchanged";
  parsed.mcpServers = { ...servers, [SERVER_NAME]: entry };
  await writePrivately(path, JSON.stringify(parsed, null, 2) + "\n");
  return existed ? "updated" : "created";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const content = await readOrEmpty(path);
  if (content.trim() === "") return {};
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(path + " does not hold a JSON object.");
  return parsed;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Replaces the file atomically, keeping its mode; a new file is private to the user. */
async function writePrivately(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // A new file.
  }
  const temporary = path + "." + process.pid + ".tmp";
  await writeFile(temporary, content, { mode, flag: "wx" });
  await rename(temporary, path);
}
