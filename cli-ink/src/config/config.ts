import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cli-ink/src/config -> Atlas/
export const ATLAS_ROOT = path.resolve(__dirname, "..", "..", "..");
export const CONFIG_PATH = path.join(ATLAS_ROOT, "config.toml");

export interface AtlasConfig {
  atlas?: {
    version?: string;
    /** Set to true once the user finishes the interactive onboarding. */
    onboarded?: boolean;
  };
  openrouter?: {
    api_key?: string;
    default_model?: string;
    base_url?: string;
    favorite_models?: string[];
  };
  memory?: {
    backend?: "file" | "vector";
    path?: string;
    max_context_entries?: number;
    max_session_history?: number;
    embeddings?: {
      api_key?: string;
      model?: string;
      base_url?: string;
    };
  };
  tools?: {
    shell_confirm?: boolean;
    brave_api_key?: string;
  };
  discord?: {
    /** Run the Discord DM bot inside `atlas`. Default: true if a token is set. */
    enabled?: boolean;
    token?: string;
    /** Discord user IDs allowed to DM the bot. Empty/missing → anyone. */
    allowed_users?: string[];
  };
}

export const DEFAULT_FAVORITES = [
  "deepseek/deepseek-chat",
  "openai/gpt-oss-120b:free",
  "anthropic/claude-sonnet-4-5",
];

export function loadConfig(): AtlasConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const text = fs.readFileSync(CONFIG_PATH, "utf-8");
  return parse(text) as AtlasConfig;
}

export function saveConfigKey(section: string, key: string, value: unknown): void {
  const cfg: any = loadConfig();
  if (!cfg[section]) cfg[section] = {};
  cfg[section][key] = value;
  fs.writeFileSync(CONFIG_PATH, stringify(cfg));
}

export function saveConfigPath(p: string[], value: unknown): void {
  const cfg: any = loadConfig();
  let cur = cfg;
  for (let i = 0; i < p.length - 1; i++) {
    const k = p[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[p[p.length - 1]] = value;
  fs.writeFileSync(CONFIG_PATH, stringify(cfg));
}
