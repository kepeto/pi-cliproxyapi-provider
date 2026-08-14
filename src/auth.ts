import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read the CLIProxyAPI api key directly from auth.json.
 *
 * omp bundles an older pi-coding-agent whose `readStoredCredential` is not
 * reliably wired into the extension runtime, so we read the file ourselves.
 * Both `~/.pi/agent/auth.json` (pi) and `~/.omp/agent/auth.json` (omp) are
 * tried; either location works.
 */
export function readAuthKeyFromDisk(providerName: string): string | undefined {
  const candidates = [
    join(homedir(), ".pi", "agent", "auth.json"),
    join(homedir(), ".omp", "agent", "auth.json"),
    process.env.CPA_AUTH_PATH,
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const cred = raw?.[providerName];
      if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key) {
        return cred.key;
      }
    } catch {
      // ignore malformed file, try next
    }
  }
  return undefined;
}

/** Persist the api key to auth.json at both pi and omp locations. */
export function writeAuthKey(providerName: string, key: string): void {
  const targets = [
    join(homedir(), ".pi", "agent", "auth.json"),
    join(homedir(), ".omp", "agent", "auth.json"),
  ];
  for (const path of targets) {
    try {
      let existing: Record<string, unknown> = {};
      if (existsSync(path)) {
        try {
          existing = JSON.parse(readFileSync(path, "utf8")) ?? {};
        } catch {
          existing = {};
        }
      }
      existing[providerName] = { type: "api_key", key };
      writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // ignore write failure for one location, try the other
    }
  }
}

export async function getStoredApiKey(providerName: string): Promise<string | undefined> {
  return readAuthKeyFromDisk(providerName) ?? process.env.CLIPROXYAPI_API_KEY;
}

export async function getDiscoveryApiKey(
  providerName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  return readAuthKeyFromDisk(providerName) ?? env.CLIPROXYAPI_API_KEY;
}
