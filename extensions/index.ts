import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { ProviderCatalog } from "../src/catalog.ts";
import { ProviderRuntime } from "../src/runtime.ts";
import { buildProviderRegistration } from "../src/registration.ts";
import { buildUnavailableProviderModels } from "../src/provider.ts";
import { registerCliproxyapiCommand } from "../src/commands.ts";
import { getDiscoveryApiKey } from "../src/auth.ts";
import { loadProviderSettings } from "../src/settings.ts";
import { registerCodexCompatiblePayloadAdapter } from "../src/codex-compat.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(extensionDir);
const bundledModelsDevPath = join(packageRoot, "data", "models-dev-fallback.json");

// Load bundled default aliases (CLIProxyAPI gateway labels) and inject them
// into DEFAULT_CONFIG so a fresh install enriches models.dev without user
// config. User config aliases override these via the normal merge.
try {
  const bundledAliasesPath = join(packageRoot, "data", "default-aliases.json");
  if (existsSync(bundledAliasesPath)) {
    const raw = JSON.parse(readFileSync(bundledAliasesPath, "utf8"));
    if (raw && typeof raw === "object") {
      DEFAULT_CONFIG.modelAliases = { ...(raw as Record<string, string>), ...DEFAULT_CONFIG.modelAliases };
    }
  }
} catch {
  // ignore — aliases are best-effort
}

export default async function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  try {
    const cwd = process.cwd();
    config = loadConfig(cwd);
    const settings = loadProviderSettings(cwd);
    const catalog = new ProviderCatalog({
      config,
      gpt56ContextWindow: settings.gpt56ContextWindow,
      bundledModelsDevPath,
      getApiKey: () => getDiscoveryApiKey(config.providerName),
    });
    const runtime = new ProviderRuntime({ pi, config, catalog });
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi, runtime, catalog);

    // Boot discovery: fetch models directly instead of waiting for omp's
    // refreshModels hook (which omp 17.3.x does not trigger with network/credential).
    const keyFn = () => getDiscoveryApiKey(config.providerName);
    try {
      await catalog.refresh("models", "manual", keyFn);
    } catch (e) {
      console.warn(`[pi-cliproxyapi-provider] boot model refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    pi.on("session_start", async () => {
      const snapshot = catalog.current();
      if (snapshot && snapshot.built.models.length > 0) return;
      try {
        await catalog.refresh("models", "manual", keyFn);
      } catch {
        // ignore — keep cached/placeholder models
      }
    });

    await runtime.start();
  } catch (error) {
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi);
    pi.registerProvider(config.providerName, buildProviderRegistration(config, buildUnavailableProviderModels()).config);
    console.warn(`[pi-cliproxyapi-provider] registered placeholder provider after startup failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}
