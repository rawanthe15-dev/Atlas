// Exercise the TodoStore directly: add, list, update, complete, delete.
import { TodoStore } from "../src/memory/todos.js";

const store = new TodoStore("/tmp/atlas_todos_test.json");

async function main() {
  // Wipe any prior state so the test is deterministic.
  await store.save([]);

  const a = await store.add({ title: "set up gaming server" });
  const b = await store.add({ title: "create voice rooms", notes: "lobby 1, lobby 2" });
  const c = await store.add({ title: "post rules in #rules" });
  console.log("→ added 3:", (await store.list()).map((t) => `${t.id}:${t.title}`).join("  "));

  await store.update(a.id, { status: "in_progress" });
  await store.update(b.id, { status: "done" });
  const active = await store.getActive();
  console.log("→ active (a, c expected):", active.map((t) => `${t.id}:${t.status}`).join("  "));

  const ok = await store.delete(c.id);
  console.log("→ delete c ok:", ok);

  const all = await store.list({ includeDone: true });
  console.log("→ final:", all.map((t) => `[${t.status}] ${t.title}`).join("  ·  "));

  if (all.length !== 2) throw new Error("expected 2 todos remaining");
  if (!all.some((t) => t.status === "in_progress")) throw new Error("expected one in_progress");
  if (!all.some((t) => t.status === "done")) throw new Error("expected one done");
  console.log("\nALL_GOOD");
}

main().catch((e) => {
  console.error("todo-test failed:", e);
  process.exit(1);
});
