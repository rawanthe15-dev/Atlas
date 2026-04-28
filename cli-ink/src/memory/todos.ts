import fs from "node:fs/promises";
import path from "node:path";
import { ATLAS_ROOT } from "../config/config.js";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  notes?: string;
  parent_id?: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_TODOS_PATH = path.join(ATLAS_ROOT, "memory", "todos.json");

/**
 * File-backed todo list shared across CLI + Discord channels. Persists to
 * `memory/todos.json` so todos survive restarts and follow the user across
 * surfaces (a todo created via Discord shows up in CLI and vice versa).
 */
export class TodoStore {
  private path: string;

  constructor(filePath: string = DEFAULT_TODOS_PATH) {
    this.path = filePath;
  }

  async load(): Promise<Todo[]> {
    try {
      const text = await fs.readFile(this.path, "utf-8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async save(todos: Todo[]): Promise<void> {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(todos, null, 2));
  }

  async add(input: { title: string; notes?: string; parent_id?: string }): Promise<Todo> {
    const todos = await this.load();
    const now = new Date().toISOString();
    const todo: Todo = {
      id: makeId(),
      title: input.title,
      status: "pending",
      notes: input.notes,
      parent_id: input.parent_id,
      created_at: now,
      updated_at: now,
    };
    todos.push(todo);
    await this.save(todos);
    return todo;
  }

  async update(
    id: string,
    patch: Partial<Pick<Todo, "title" | "status" | "notes" | "parent_id">>,
  ): Promise<Todo | null> {
    const todos = await this.load();
    const i = todos.findIndex((t) => t.id === id);
    if (i < 0) return null;
    todos[i] = { ...todos[i], ...patch, updated_at: new Date().toISOString() };
    await this.save(todos);
    return todos[i];
  }

  async delete(id: string): Promise<boolean> {
    const todos = await this.load();
    const next = todos.filter((t) => t.id !== id);
    if (next.length === todos.length) return false;
    await this.save(next);
    return true;
  }

  async list(filter?: { status?: TodoStatus; includeDone?: boolean }): Promise<Todo[]> {
    let todos = await this.load();
    if (filter?.status) {
      todos = todos.filter((t) => t.status === filter.status);
      return todos;
    }
    if (filter?.includeDone === false) {
      todos = todos.filter((t) => t.status !== "done");
    }
    return todos;
  }

  /** Pending + in-progress todos. Used to inject into the agent's system prompt. */
  async getActive(): Promise<Todo[]> {
    const todos = await this.load();
    return todos.filter((t) => t.status !== "done");
  }
}

function makeId(): string {
  // 6 random base36 chars + base36 timestamp suffix → human-friendly + unique enough.
  return Math.random().toString(36).slice(2, 8) + "-" + Date.now().toString(36).slice(-4);
}
