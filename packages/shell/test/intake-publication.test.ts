import { expect, it, vi } from "vitest";
import { IntakePublication } from "../src/intake/publication";
import type { IntakeOwnerCustody, IntakeOwnerVault } from "../src/intake/owner-custody";
import { IntakeSession } from "../src/intake/session";
import type { WorkerClient } from "../src/app/worker-client";
import { IndexedDbIntakeWorkflows } from "../src/intake/workflows";
import { OwnedFactory } from "./helpers/owned-idb";

it.each(["custody", "save", "relay", "publish", "acknowledgement"])("resumes the original secret-free publication after a lost %s response", async fault => {
  const cacheRows = new Map<string, string>(); const custody = new Map<string, IntakeOwnerCustody>();
  const workflows = new IndexedDbIntakeWorkflows(new OwnedFactory() as unknown as IDBFactory);
  const cache = { getItem: (key: string) => cacheRows.get(key) ?? null, setItem: (key: string, value: string) => { cacheRows.set(key, value); }, removeItem: (key: string) => { cacheRows.delete(key); } };
  let lost = false; let serial = 0;
  const vault: IntakeOwnerVault = { read: async key => custody.get(key) ?? null, insert: async value => {
    custody.set(value.key, structuredClone(value)); if (fault === "custody" && !lost) { lost = true; throw new Error("Owned commit response loss"); }
  } };
  let target = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "2", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const initial = structuredClone(target); const results = new Map<string, any>(); let forms: any[] = [];
  const commands: any[] = [];
  const worker = { createMutationContext: () => ({ requestId: `req_${String.fromCharCode(97 + ++serial).repeat(26)}` }),
    intakePresentation: async () => ({ authorityTarget: target, forms, inbox: [], receipts: [], rules: [], deliveryFailures: [], tables: [], trace: {}, legacyCustody: "none" }),
    mutationOutcome: async (_route: string, _payload: unknown, context: { requestId: string }) => results.get(context.requestId) ?? { status: "not_invoked" },
    intakeCommand: async (payload: any, context: { requestId: string }) => {
      commands.push(structuredClone({ payload, context }));
      expect(payload.authorityTarget).toEqual(target);
      const isSave = payload.command.route === "intake.saveForm";
      const form = isSave ? payload.command.payload.form : { ...forms[0], publishedAt: payload.command.payload.publishedAt };
      forms = [form]; target = { ...target, protectionRevision: String(Number(target.protectionRevision) + 1) };
      results.set(context.requestId, { status: "recorded", current: true, result: form, target });
      if (!lost && fault === (isSave ? "save" : "publish")) { lost = true; throw new Error("Owned worker response loss"); }
      return form;
    } } as unknown as WorkerClient;
  let registered: string | undefined; let registrations = 0;
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(custody.size).toBe(1); expect(forms).toHaveLength(1);
    const body = String(init?.body); expect(body.includes("ownerPrivateKey")).toBe(false);
    if (registered) expect(body === registered).toBe(true); registered = body; registrations++;
    if (fault === "relay" && !lost) { lost = true; throw new Error("Owned relay response loss"); }
    const metadata = JSON.parse(body) as { formId: string; expiresAt: string };
    if (fault === "acknowledgement" && !lost) { lost = true; return new Response(JSON.stringify({ formId: `form_${"z".repeat(26)}`, expiresAt: metadata.expiresAt }), { status: 201 }); }
    return new Response(JSON.stringify({ formId: metadata.formId, expiresAt: metadata.expiresAt }), { status: 201 });
  });
  const make = () => new IntakePublication(new IntakeSession(cache, worker, initial.appInstanceId), vault,
    { shellOrigin: "https://app.example.test", relayBaseUrl: "https://relay.example.test/", publicBaseUrl: "https://app.example.test" }, fetchImpl, workflows);
  const first = make(); await first.session.read(); await first.recover();
  await first.begin({ title: "Owned request", description: "", expiresAt: "2030-01-01T00:00:00.000Z", target: { tableId: "tbl_11111111-1111-7111-8111-111111111111", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_22222222-2222-7222-8222-222222222222", label: "Name", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] });
  const original = first.pending()!;
  expect(await first.resume().then(() => false, () => true)).toBe(true); // Never print capability-bearing successful results in RED output.
  expect(first.pending()!.formId).toBe(original.formId);
  const reloaded = make(); const outcome = await reloaded.resume();
  expect(outcome.localForm.publicForm.formId).toBe(original.formId);
  expect(outcome.localForm.publishedAt).not.toBeNull(); expect(forms).toHaveLength(1); expect(custody.size).toBe(1);
  expect(commands).toHaveLength(2); expect(registrations).toBe(fault === "relay" || fault === "acknowledgement" ? 2 : 1);
  expect(JSON.stringify(commands).match(/ownerPrivateKey|ownerToken|submitToken/)).toBeNull();
  expect([...cacheRows.values()].join("").match(/ownerPrivateKey|ownerToken|submitToken/)).toBeNull();
  expect(reloaded.pending()).not.toBeNull(); // Kept until the published link has been presented.
  await reloaded.finish(); expect(reloaded.pending()).toBeNull();
});

it("denies unconfigured and non-origin-bound publication before custody or HTTP", () => {
  const session = {} as IntakeSession; const vault = {} as IntakeOwnerVault;
  expect(() => new IntakePublication(session, vault, { shellOrigin: "https://app.example.test", publicBaseUrl: "https://other.example.test", relayBaseUrl: "https://relay.example.test" })).toThrow(/configuration/);
  expect(() => new IntakePublication(session, vault, { shellOrigin: "https://app.example.test", publicBaseUrl: "https://app.example.test", relayBaseUrl: null })).toThrow(/configuration/);
});

it.each(["save_identity", "publish_identity", "publication_state"])("rejects retained %s inconsistency before the next worker or HTTP effect", async fault => {
  const rows = new Map<string, string>(); const records = new Map<string, IntakeOwnerCustody>();
  const cache = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const source = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "2", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const saveId = `req_${"d".repeat(26)}`, publishId = `req_${"e".repeat(26)}`;
  const mutate = vi.fn(async () => { throw new Error("Owned effect must not run"); }); const fetchImpl = vi.fn(async () => { throw new Error("Owned HTTP must not run"); });
  const vault: IntakeOwnerVault = { read: async key => records.get(key) ?? null, insert: async record => { records.set(record.key, record); throw new Error("Owned custody response loss"); } };
  const worker = { createMutationContext: () => ({ requestId: saveId }), intakeCommand: mutate, mutationOutcome: async () => ({ status: "not_invoked" }),
    intakePresentation: async () => ({ authorityTarget: source, forms: [], inbox: [], receipts: [], rules: [], deliveryFailures: [], tables: [], trace: {}, legacyCustody: "none" }) } as unknown as WorkerClient;
  const session = new IntakeSession(cache, worker, source.appInstanceId); await session.read();
  const publication = new IntakePublication(session, vault, { shellOrigin: "https://app.example.test", publicBaseUrl: "https://app.example.test", relayBaseUrl: "https://relay.example.test/" }, fetchImpl,
    new IndexedDbIntakeWorkflows(new OwnedFactory() as unknown as IDBFactory));
  await publication.recover();
  await publication.begin({ title: "Owned request", description: "", expiresAt: "2030-01-01T00:00:00.000Z", target: { tableId: "tbl_11111111-1111-7111-8111-111111111111", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_22222222-2222-7222-8222-222222222222", label: "Name", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] });
  expect(await publication.resume().then(() => false, () => true)).toBe(true);
  const job = publication.pending()!; const form = [...records.values()][0]!.form;
  job.save = { schema: 1, appInstanceId: source.appInstanceId, slot: "intake", route: "intake.command", requestId: saveId,
    payload: { authorityTarget: source, command: { route: "intake.saveForm", payload: { form: fault === "save_identity" ? { ...form, publicForm: { ...form.publicForm, formId: `form_${"z".repeat(26)}` } } : form } } } };
  job.publish = { schema: 1, appInstanceId: source.appInstanceId, slot: "intake", route: "intake.command", requestId: publishId,
    payload: { authorityTarget: source, command: { route: "intake.markPublished", payload: { formId: fault === "publish_identity" ? `form_${"z".repeat(26)}` : job.formId, publishedAt: "2026-09-13T12:00:00.000Z" } } } };
  if (fault === "publication_state") { job.relayConfirmed = true; job.relayInvoked = false; }
  const key = `clay_intake_publication_v1:${source.appInstanceId}`; const original = JSON.stringify(job); rows.set(key, original);
  expect(await publication.resume().then(() => false, () => true)).toBe(true);
  expect(mutate.mock.calls.length).toBe(0); expect(fetchImpl.mock.calls.length).toBe(0); expect(rows.get(key) === original).toBe(true);
});
