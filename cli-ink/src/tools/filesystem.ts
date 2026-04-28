import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./tool.js";

const MAX_READ_CHARS = 8000;

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file at the given path.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative path to the file." },
    },
    required: ["path"],
  },
  async run(args) {
    const p = String(args.path ?? "");
    if (!p) return "Tool error: missing 'path'.";
    try {
      let text = await fs.readFile(path.resolve(p), "utf-8");
      if (text.length > MAX_READ_CHARS) {
        text = text.slice(0, MAX_READ_CHARS) + `\n... (truncated, ${text.length} chars total)`;
      }
      return text;
    } catch (e: any) {
      return `Tool error: ${e.message ?? e}`;
    }
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file. Overwrites if it exists.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to write to." },
      content: { type: "string", description: "File contents." },
    },
    required: ["path", "content"],
  },
  async run(args) {
    const p = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!p) return "Tool error: missing 'path'.";
    try {
      const resolved = path.resolve(p);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content);
      return `wrote ${content.length} chars to ${resolved}`;
    } catch (e: any) {
      return `Tool error: ${e.message ?? e}`;
    }
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List entries in a directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path." },
    },
    required: ["path"],
  },
  async run(args) {
    const p = String(args.path ?? "");
    if (!p) return "Tool error: missing 'path'.";
    try {
      const entries = await fs.readdir(path.resolve(p), { withFileTypes: true });
      return entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`).join("\n");
    } catch (e: any) {
      return `Tool error: ${e.message ?? e}`;
    }
  },
};
