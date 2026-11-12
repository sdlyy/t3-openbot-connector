import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeError } from "./errors.js";

export type LocationSource = "flag" | "environment" | "detected";
export interface AutomationLocation {
  directory: string;
  source: LocationSource;
}

/** Where OpenBot keeps application data on this platform. */
export function dataRoots(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") return [join(homedir(), "Library", "Application Support")];
  if (platform === "win32") return [env.APPDATA ?? join(homedir(), "AppData", "Roaming")];
  return [env.XDG_CONFIG_HOME ?? join(homedir(), ".config")];
}

/** The installed app and every development profile that publishes automation files right now. */
export async function detectAutomationDirectories(roots = dataRoots()): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry !== "OpenBot" && !entry.startsWith("OpenBot Dev")) continue;
      const directory = join(root, entry, "automation");
      if (await exists(join(directory, "url"))) found.push(directory);
    }
  }
  return found.sort();
}

export interface LocateOptions {
  explicit?: string | undefined;
  env?: NodeJS.ProcessEnv;
  roots?: string[];
}

/** A flag wins, then the environment, then the one profile that is publishing files. */
export async function locateAutomation(options: LocateOptions = {}): Promise<AutomationLocation> {
  const env = options.env ?? process.env;
  if (options.explicit) return { directory: resolve(options.explicit), source: "flag" };
  if (env.OPENBOT_AUTOMATION_DIR) return { directory: resolve(env.OPENBOT_AUTOMATION_DIR), source: "environment" };
  const found = await detectAutomationDirectories(options.roots);
  const [first] = found;
  if (first !== undefined && found.length === 1) return { directory: first, source: "detected" };
  if (found.length === 0) {
    throw new BridgeError(
      "openbot_offline",
      "No OpenBot profile publishes automation files. Start OpenBot and enable Local scripts for an agent, or pass --automation-dir.",
      true,
    );
  }
  throw new BridgeError(
    "openbot_profile_ambiguous",
    "Several OpenBot profiles publish automation files: " +
      found.join(", ") +
      ". Pass --automation-dir or set OPENBOT_AUTOMATION_DIR.",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The T3 thread this provider session belongs to. T3 Code sets it; other hosts do not. */
export function callingThreadId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.T3CODE_THREAD_ID?.trim();
  // The ID is written into an instruction for another agent, so it must look like an ID.
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}
