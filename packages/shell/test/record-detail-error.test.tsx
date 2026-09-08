/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ClayStore, InProcessAsyncStore, deriveInverse, type AsyncStore, type ForwardOpT } from "@clay/kernel";
import { RecordDetail } from "../src/app/RecordDetail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runWrite = <T,>(operation: () => Promise<T>): Promise<T> => operation();

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
    store={rejecting} runWrite={runWrite} onNavigate={() => undefined} onClose={() => undefined}
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

it("preserves a newer draft in another field when an earlier save reloads", async () => {
  const store = await ClayStore.openMemory();
  const ops: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", type: "text", required: true },
    { name: "details", type: "text", required: false },
  ] }];
  store.commit({ intent: "tasks", summary: "Tasks.",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
  const row = store.insert("tasks", { title: "Title before", details: "Details before" });
  const base = new InProcessAsyncStore(store);
  let releaseTitle!: () => void;
  const titleGate = new Promise<void>(resolve => { releaseTitle = resolve; });
  let markTitleStarted!: () => void;
  const titleStarted = new Promise<void>(resolve => { markTitleStarted = resolve; });
  const delayed = new Proxy(base, {
    get(target, property) {
      if (property === "update") return async (
        ...args: Parameters<InProcessAsyncStore["update"]>
      ) => {
        if (Object.hasOwn(args[2], "title")) {
          markTitleStarted();
          await titleGate;
        }
        return target.update(...args);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AsyncStore;
  let markSaved!: () => void;
  const saved = new Promise<void>(resolve => { markSaved = resolve; });
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<RecordDetail table={store.registrySnapshot().get("tasks")!}
    recordId={String(row.id)} tables={[store.registrySnapshot().get("tasks")!]}
    store={delayed} runWrite={runWrite} onNavigate={() => undefined} onClose={() => undefined}
    onWrite={markSaved} onInfo={() => undefined}
    onError={message => { throw new Error(message); }} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const title = document.body.querySelector<HTMLInputElement>("#record-title")!;
  const details = document.body.querySelector<HTMLInputElement>("#record-details")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(title, "Title saved");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => title.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await titleStarted;
  await act(async () => {
    setter.call(details, "Newer unsaved details");
    details.dispatchEvent(new Event("input", { bubbles: true }));
  });
  releaseTitle();
  await act(async () => { await saved; });
  expect(store.query({ from: "tasks" })[0]).toMatchObject({
    title: "Title saved", details: "Details before",
  });
  expect(document.body.querySelector<HTMLInputElement>("#record-details")!.value)
    .toBe("Newer unsaved details");
  await act(async () => root.unmount()); store.close();
});

it("ignores a stale save reload after record navigation", async () => {
  const store = await ClayStore.openMemory();
  const ops: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", type: "text", required: true },
  ] }];
  store.commit({ intent: "tasks", summary: "Tasks.",
    migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
  const first = store.insert("tasks", { title: "First record" });
  const second = store.insert("tasks", { title: "Second record" });
  const base = new InProcessAsyncStore(store);
  let delayFirstReload = false;
  let releaseFirstReload!: () => void;
  const firstReloadGate = new Promise<void>(resolve => { releaseFirstReload = resolve; });
  let markFirstReloadStarted!: () => void;
  const firstReloadStarted = new Promise<void>(resolve => { markFirstReloadStarted = resolve; });
  const delayed = new Proxy(base, {
    get(target, property) {
      if (property === "update") return async (
        ...args: Parameters<InProcessAsyncStore["update"]>
      ) => {
        const result = await target.update(...args);
        if (args[1] === first.id) delayFirstReload = true;
        return result;
      };
      if (property === "query") return async (
        ...args: Parameters<InProcessAsyncStore["query"]>
      ) => {
        const requestedId = args[0].where?.find(condition => condition.field === "id")?.value;
        if (delayFirstReload && requestedId === first.id) {
          delayFirstReload = false;
          markFirstReloadStarted();
          await firstReloadGate;
        }
        return target.query(...args);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AsyncStore;
  let markFirstSaved!: () => void;
  const firstSaved = new Promise<void>(resolve => { markFirstSaved = resolve; });
  const table = store.registrySnapshot().get("tasks")!;
  const props = {
    table, tables: [table], store: delayed, runWrite,
    onNavigate: () => undefined, onClose: () => undefined,
    onWrite: markFirstSaved, onInfo: () => undefined,
    onError: (message: string) => { throw new Error(message); },
  };
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<RecordDetail {...props} recordId={String(first.id)} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const input = document.body.querySelector<HTMLInputElement>("#record-title")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "First saved");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await firstReloadStarted;
  await act(async () => root.render(<RecordDetail {...props} recordId={String(second.id)} />));
  for (let attempt = 0; attempt < 50
    && document.body.querySelector<HTMLInputElement>("#record-title")?.value !== "Second record"; attempt++)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.body.querySelector<HTMLInputElement>("#record-title")?.value).toBe("Second record");
  releaseFirstReload();
  await act(async () => { await firstSaved; });
  expect(document.body.querySelector<HTMLInputElement>("#record-title")?.value).toBe("Second record");
  expect(document.body.querySelector(".record-detail h2")?.textContent).toBe("Second record");
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
    store={new InProcessAsyncStore(store)} runWrite={runWrite} onNavigate={() => undefined} onClose={() => { closes++; }}
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

it("preserves a dirty rich-note draft when a canonical reload changes that field", async () => {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "notes", columns: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "rich_text", required: false },
  ] }];
  store.commit({ intent: "notes", summary: "Notes.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  const row = store.insert("notes", { title: "Before", body: "Canonical before" });
  const base = new InProcessAsyncStore(store);
  let markReloaded!: () => void;
  const reloaded = new Promise<void>(resolve => { markReloaded = resolve; });
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<RecordDetail
    store={base} table={store.registrySnapshot().get("notes")!}
    recordId={String(row.id)} tables={[store.registrySnapshot().get("notes")!]}
    onClose={() => undefined} runWrite={runWrite} onNavigate={() => undefined}
    onWrite={markReloaded} onInfo={() => undefined}
    onError={message => { throw new Error(message); }} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const textarea = document.body.querySelector<HTMLTextAreaElement>(".rich-note-editor textarea")!;
  const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    textareaSetter.call(textarea, "Newest local draft");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await base.update("notes", String(row.id),
    { body: "Remote canonical" }, { requestId: `req_${"a".repeat(26)}` }); });
  const title = document.body.querySelector<HTMLInputElement>("#record-title")!;
  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    inputSetter.call(title, "After");
    title.dispatchEvent(new Event("input", { bubbles: true }));
    title.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await reloaded;
  });

  expect(store.query({ from: "notes" })[0]?.body).toBe("Remote canonical");
  expect(document.body.querySelector<HTMLTextAreaElement>(".rich-note-editor textarea")!.value)
    .toBe("Newest local draft");
  await act(async () => root.unmount());
  store.close();
});

it("synchronously blocks overlapping rich-note toolbar saves", async () => {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "notes", columns: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "rich_text", required: false },
  ] }];
  store.commit({ intent: "notes", summary: "Notes.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  const row = store.insert("notes", { title: "Plan", body: "hello" });
  const base = new InProcessAsyncStore(store);
  let releaseUpdates!: () => void;
  const updateGate = new Promise<void>(resolve => { releaseUpdates = resolve; });
  let updateCalls = 0;
  const delayed = new Proxy(base, {
    get(target, property) {
      if (property === "update") return async (
        ...args: Parameters<InProcessAsyncStore["update"]>
      ) => {
        updateCalls++;
        await updateGate;
        return target.update(...args);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AsyncStore;
  let completedSaves = 0;
  const host = document.createElement("div"); document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => root.render(<RecordDetail
    store={delayed} table={store.registrySnapshot().get("notes")!}
    recordId={String(row.id)} tables={[store.registrySnapshot().get("notes")!]}
    onClose={() => undefined} runWrite={runWrite} onNavigate={() => undefined}
    onWrite={() => { completedSaves++; }} onInfo={() => undefined}
    onError={message => { throw new Error(message); }} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const textarea = document.body.querySelector<HTMLTextAreaElement>(".rich-note-editor textarea")!;
  textarea.focus(); textarea.setSelectionRange(0, 5);
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>(
      '.rich-note-toolbar button[title="Bold"]')!.click();
    document.body.querySelector<HTMLButtonElement>(
      '.rich-note-toolbar button[title="Italic"]')!.click();
    await Promise.resolve();
  });
  const callsAfterOverlapAttempt = updateCalls;
  const formattingButtons = [...document.body.querySelectorAll<HTMLButtonElement>(
    ".rich-note-toolbar button[title]",
  )];
  expect(formattingButtons.every(button => button.disabled)).toBe(true);

  releaseUpdates();
  for (let attempt = 0; attempt < 50 && completedSaves < updateCalls; attempt++)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const canonicalBody = store.query({ from: "notes" })[0]?.body;
  await act(async () => root.unmount());
  store.close();

  expect(callsAfterOverlapAttempt).toBe(1);
  expect(canonicalBody).toBe("**hello**");
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
    onClose={() => undefined} runWrite={runWrite} onNavigate={() => undefined}
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
