/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ClayStore, InProcessAsyncStore, deriveInverse, type AsyncStore, type ForwardOpT } from "@clay/kernel";
import { RecordDetail } from "../src/app/RecordDetail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("resets a rejected scalar edit to the canonical value", async () => {
  const store = await ClayStore.openMemory();
  const ops: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", type: "text", required: true },
  ] }];
  store.commit({ intent: "tasks", summary: "Tasks.",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
  const row = store.insert("tasks", { title: "Canonical" });
  const base = new InProcessAsyncStore(store);
  const rejecting = new Proxy(base, {
    get(target, property) {
      if (property === "update") return async () => { throw new Error("rejected edit"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AsyncStore;
  const errors: string[] = [];
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<RecordDetail table={store.registrySnapshot().get("tasks")!}
    recordId={String(row.id)} tables={[store.registrySnapshot().get("tasks")!]}
    store={rejecting} onNavigate={() => undefined} onClose={() => undefined}
    onWrite={() => undefined} onInfo={() => undefined} onError={message => errors.push(message)} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  expect(document.body.style.overflow).toBe("hidden");
  const input = document.body.querySelector<HTMLInputElement>('#record-title')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "Unsaved"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(errors).toContain("rejected edit");
  expect(input.value).toBe("Canonical");
  await act(async () => root.unmount()); store.close();
});

it("ignores unchanged blur and Escape cancels only the dirty field", async () => {
  const store = await ClayStore.openMemory();
  const ops: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", type: "text", required: true },
  ] }];
  store.commit({ intent: "tasks", summary: "Tasks.",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
  const row = store.insert("tasks", { title: "Canonical" });
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  let closes = 0;
  await act(async () => root.render(<RecordDetail table={store.registrySnapshot().get("tasks")!}
    recordId={String(row.id)} tables={[store.registrySnapshot().get("tasks")!]}
    store={new InProcessAsyncStore(store)} onNavigate={() => undefined} onClose={() => { closes++; }}
    onWrite={() => undefined} onInfo={() => undefined} onError={message => { throw new Error(message); }} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const input = document.body.querySelector<HTMLInputElement>('#record-title')!;
  const before = store.rowHistoryCount();
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(store.rowHistoryCount()).toBe(before);

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "Canceled draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(closes).toBe(0);
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(input.value).toBe("Canonical");
  expect(store.query({ from: "tasks" })[0]!.title).toBe("Canonical");
  expect(store.rowHistoryCount()).toBe(before);
  await act(async () => root.unmount()); store.close();
});

it("persists rich-note toolbar formatting instead of only changing local draft state", async () => {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "notes", columns: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "rich_text", required: false },
  ] }];
  store.commit({ intent: "notes", summary: "Notes.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  const row = store.insert("notes", { title: "Plan", body: "hello" });
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<RecordDetail
    store={new InProcessAsyncStore(store)} table={store.registrySnapshot().get("notes")!}
    recordId={String(row.id)} tables={[store.registrySnapshot().get("notes")!]}
    onClose={() => undefined} onNavigate={() => undefined}
    onWrite={() => undefined} onInfo={() => undefined}
    onError={message => { throw new Error(message); }} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const textarea = document.body.querySelector<HTMLTextAreaElement>(".rich-note-editor textarea")!;
  textarea.focus(); textarea.setSelectionRange(0, 5);
  await act(async () => document.body.querySelector<HTMLButtonElement>(
    '.rich-note-toolbar button[title="Bold"]')!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(store.query({ from: "notes" })[0]?.body).toBe("**hello**");
  await act(async () => root.unmount()); store.close();
});
