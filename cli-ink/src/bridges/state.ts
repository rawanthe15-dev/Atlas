import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { specFromJSON, specToJSON, type BridgeSpec } from "./types.js";

/**
 * Persists every mounted device under `memory/devices/<name>.json` so they
 * survive Atlas restarts.
 */
export class DeviceStore {
  constructor(private root: string) {}

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  private path(name: string): string {
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
    return join(this.root, `${safe}.json`);
  }

  async save(spec: BridgeSpec): Promise<void> {
    await this.ensure();
    await writeFile(this.path(spec.name), JSON.stringify(specToJSON(spec), null, 2), "utf8");
  }

  async delete(name: string): Promise<void> {
    try {
      await rm(this.path(name));
    } catch {
      /* ignore — already gone */
    }
  }

  async loadAll(): Promise<BridgeSpec[]> {
    try {
      await this.ensure();
      const files = await readdir(this.root);
      const out: BridgeSpec[] = [];
      for (const f of files.sort()) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.root, f), "utf8");
          out.push(specFromJSON(JSON.parse(raw)));
        } catch {
          /* skip malformed */
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
