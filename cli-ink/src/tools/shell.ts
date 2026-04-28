import { spawn } from "node:child_process";
import type { Tool } from "./tool.js";

const MAX_OUTPUT_CHARS = 4000;

export type ShellConfirmFn = (cmd: string) => Promise<boolean>;

export function makeShellTool(opts: { confirm?: ShellConfirmFn } = {}): Tool {
  return {
    name: "shell",
    description: "Execute a shell command and return its combined stdout/stderr. Output is truncated past 4000 chars.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
    async run(args) {
      const command = String(args.command ?? "").trim();
      if (!command) return "Tool error: missing 'command'.";

      if (opts.confirm) {
        const ok = await opts.confirm(command);
        if (!ok) return "User declined to run the command.";
      }

      return new Promise<string>((resolve) => {
        const proc = spawn("bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        proc.stdout.on("data", (b) => chunks.push(b));
        proc.stderr.on("data", (b) => chunks.push(b));
        proc.on("error", (err) => resolve(`Tool error: ${err.message}`));
        proc.on("close", (code) => {
          let out = Buffer.concat(chunks).toString("utf-8");
          if (out.length > MAX_OUTPUT_CHARS) {
            out = out.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${out.length} bytes total)`;
          }
          resolve(`exit ${code ?? "?"}\n${out}`);
        });
      });
    },
  };
}
