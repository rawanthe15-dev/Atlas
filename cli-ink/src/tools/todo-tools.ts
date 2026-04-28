import type { Tool } from "./tool.js";
import type { TodoStore } from "../memory/todos.js";

export function makeTodoTools(store: TodoStore): Tool[] {
  return [todoAdd(store), todoUpdate(store), todoComplete(store), todoDelete(store), todoList(store)];
}

function todoAdd(store: TodoStore): Tool {
  return {
    name: "todo_add",
    description:
      "Add a todo to your persistent task list. Use this for multi-step work: plan ALL steps upfront with one todo_add per step, then execute them by calling tools (multiple tools per turn when independent). Update todos with todo_complete as you finish each step.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Concise action — what needs to be done." },
        notes: { type: "string", description: "Optional details / context." },
        parent_id: { type: "string", description: "Optional id of a parent todo to nest this under." },
      },
      required: ["title"],
    },
    async run(args) {
      const todo = await store.add({
        title: String(args.title),
        notes: args.notes ? String(args.notes) : undefined,
        parent_id: args.parent_id ? String(args.parent_id) : undefined,
      });
      return `added [${todo.id}] ${todo.title}`;
    },
  };
}

function todoUpdate(store: TodoStore): Tool {
  return {
    name: "todo_update",
    description:
      "Update a todo's title, status, or notes. status must be 'pending', 'in_progress', or 'done'.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "done"] },
        notes: { type: "string" },
      },
      required: ["id"],
    },
    async run(args) {
      const patch: any = {};
      if (args.title) patch.title = String(args.title);
      if (args.status) patch.status = args.status;
      if (args.notes) patch.notes = String(args.notes);
      const todo = await store.update(String(args.id), patch);
      if (!todo) return `Tool error: todo '${args.id}' not found.`;
      return `updated [${todo.id}] [${todo.status}] ${todo.title}`;
    },
  };
}

function todoComplete(store: TodoStore): Tool {
  return {
    name: "todo_complete",
    description: "Mark a todo as done. Shortcut for todo_update(status='done').",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async run(args) {
      const todo = await store.update(String(args.id), { status: "done" });
      if (!todo) return `Tool error: todo '${args.id}' not found.`;
      return `✓ done [${todo.id}] ${todo.title}`;
    },
  };
}

function todoDelete(store: TodoStore): Tool {
  return {
    name: "todo_delete",
    description: "Delete a todo permanently.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async run(args) {
      const ok = await store.delete(String(args.id));
      return ok ? `deleted ${args.id}.` : `Tool error: todo '${args.id}' not found.`;
    },
  };
}

function todoList(store: TodoStore): Tool {
  return {
    name: "todo_list",
    description:
      "List your current todos. By default shows active (pending + in_progress) todos only. Pass include_done=true to also see completed work.",
    parameters: {
      type: "object",
      properties: {
        include_done: { type: "boolean", description: "Default false." },
      },
      required: [],
    },
    async run(args) {
      const list = await store.list({ includeDone: args.include_done === true });
      if (list.length === 0) return "(no todos)";
      return list
        .map(
          (t) =>
            `[${t.id}] [${t.status.padEnd(11)}] ${t.title}${t.notes ? `\n   notes: ${t.notes}` : ""}`,
        )
        .join("\n");
    },
  };
}
