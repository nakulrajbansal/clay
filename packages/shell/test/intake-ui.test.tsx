/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://app.example.test"} */
import { useState } from "react";
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IntakeDeliveryFailure, IntakeInboxItem, RegTable, SemanticSchemaTraceV1,
} from "@clay/kernel";
import type {
  IntakeSubmissionPlaintextV1, LocalIntakeFormV2, PublicIntakeLinkPayloadV1,
} from "@clay/schema/intake";
import { IntakeCenter } from "../src/app/IntakeCenter";
import { PublicIntakeForm } from "../src/intake/PublicIntakeForm";
import {
  decryptIntakeSubmission, encryptIntakeSubmission, generateIntakeOwnerKeyPair,
} from "../src/intake/crypto";
import type { WorkerClient } from "../src/app/worker-client";
import { hydrateIntakeOwnerForm, type IntakeOwnerCustody, type IntakeOwnerVault } from "../src/intake/owner-custody";
import { mintIntakeToken } from "../src/intake/client";
import { IndexedDbIntakeWorkflows, IntakeWorkflowSlot } from "../src/intake/workflows";
import { OwnedFactory } from "./helpers/owned-idb";
import { relayRequestSha256 } from "../src/app/relay-request-identity";
import { IntakePublication } from "../src/intake/publication";
import { IntakeSession } from "../src/intake/session";
import { expectControlCensus } from "./helpers/control-census";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tableId = "tbl_018f0000-0000-7000-8000-000000000001";
const nameFieldId = "fld_018f0000-0000-7000-8000-000000000002";
const fileFieldId = "fld_018f0000-0000-7000-8000-000000000003";
const appInstanceId = `app_${"a".repeat(26)}`;
const target = { appInstanceId, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
const ownerSource = { appInstanceId, activeGenerationId: target.activeGenerationId, lineageEpoch: target.lineageEpoch };
const custody = new Map<string, IntakeOwnerCustody>();
const vault: IntakeOwnerVault = { read: async key => custody.get(key) ?? null, insert: async row => { custody.set(row.key, structuredClone(row)); } };
let workflows: IndexedDbIntakeWorkflows;
beforeEach(() => { custody.clear(); sessionStorage.clear(); workflows = new IndexedDbIntakeWorkflows(new OwnedFactory() as unknown as IDBFactory); }); // Owned jsdom only.

// The UI protocol fixture transports public V2 metadata only; generated private
// fixture material lives in the separate owned vault, just as at the shell boundary.
function protocol(methods: Record<string, (...args: any[]) => Promise<any>>): WorkerClient {
  let serial = 0; let current = structuredClone(target); const outcomes = new Map<string, unknown>();
  const handlers: Record<string, (p: any) => Promise<unknown>> = {
    "intake.saveForm": p => methods.saveIntakeForm!(p.form),
    "intake.closePublication": async p => methods.closeIntakePublication ? methods.closeIntakePublication(p.form)
      : ({ schema: 1, form: p.form, terminal: true, closedAt: new Date().toISOString() }),
    "intake.markPublished": p => methods.markIntakeFormPublished!(p.formId, p.publishedAt),
    "intake.markExpired": p => methods.markIntakeFormExpired!(p.formId, p.expiredAt),
    "intake.revokeForm": p => methods.revokeIntakeForm!(p.formId, p.revokedAt),
    "intake.stageSubmission": p => methods.stageIntakeSubmission!(p.submission),
    "intake.recordDeliveryFailure": p => methods.recordIntakeDeliveryFailure!(p.failure),
    "intake.authorizeDeliveryDiscard": p => methods.authorizeIntakeDeliveryDiscard!(p.formId, p.submissionId, p.authorizedAt),
    "intake.resolveDeliveryFailure": p => methods.resolveIntakeDeliveryFailure!(p.formId, p.submissionId, p.resolution, p.resolvedAt),
  };
  return {
    createMutationContext: () => ({ requestId: `req_${String.fromCharCode(97 + ++serial).repeat(26)}` }),
    intakePresentation: async () => ({ authorityTarget: current, legacyCustody: "none", forms: await methods.listIntakeForms!(), rules: [],
      inbox: await methods.intakeInbox!(), receipts: await methods.intakeReceipts!(), deliveryFailures: await methods.intakeDeliveryFailures!(), tables, trace: semanticTrace }),
    mutationOutcome: async (_route: string, _payload: unknown, context: { requestId: string }) => outcomes.get(context.requestId) ?? { status: "not_invoked" },
    cancelPresentation: async (_route: string, _payload: unknown, context: { requestId: string }) => {
      if (!outcomes.has(context.requestId)) outcomes.set(context.requestId, { status: "cancelled" });
      return outcomes.get(context.requestId);
    },
    intakeCommand: async (payload: any, context: { requestId: string }) => {
      if ((outcomes.get(context.requestId) as { status?: string } | undefined)?.status === "cancelled") throw new Error("Owned invocation cancelled");
      expect(JSON.stringify(payload).match(/ownerPrivateKey|ownerToken|submitToken/)).toBeNull();
      expect(payload.authorityTarget).toEqual(current);
      const result = await handlers[payload.command.route]!(payload.command.payload);
      current = { ...current, protectionRevision: String(Number(current.protectionRevision) + 1) };
      outcomes.set(context.requestId, { status: "recorded", current: true, result, target: current }); return result;
    },
  } as unknown as WorkerClient;
}
const tables = [{
  name: "requests",
  columns: [
    { name: "name", label: "Customer name", type: "text", required: true },
    { name: "files", label: "Supporting document", type: "attachment", required: false },
  ],
}] as RegTable[];
const semanticTrace = {
  v: 1,
  atVersion: 3,
  tables: [{ tableId, name: "requests", label: "Requests", aliases: [], state: "visible" }],
  fields: [
    { tableId, fieldId: nameFieldId, tableName: "requests", fieldName: "name",
      label: "Customer name", aliases: [], state: "visible" },
    { tableId, fieldId: fileFieldId, tableName: "requests", fieldName: "files",
      label: "Supporting document", aliases: [], state: "visible" },
  ],
  relationships: [], opBindings: [],
} as unknown as SemanticSchemaTraceV1;

const flush = async (): Promise<void> => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
};
const waitForUi = async (ready: () => boolean): Promise<void> => {
  // Serial act scopes; a timer-based async polling callback can overlap React
  // scopes and contaminate the next test while a custody operation is pending.
  for (let attempt = 0; attempt < 100; attempt++) { await flush(); if (ready()) return; }
  throw new Error("Owned UI operation did not reach its observable terminal state");
};

function publishedForm(input: {
  publicKey: string;
  privateKey: string;
  formId: string;
  title: string;
  submitToken: string;
  ownerToken: string;
  expiresAt: string;
}): LocalIntakeFormV2 {
  const form: LocalIntakeFormV2 = {
    schema: 2, ownerSource, terminalReason: null,
    publicForm: {
      schema: 1,
      formId: input.formId,
      revision: 1,
      title: input.title,
      description: "Secure request.",
      target: { tableId, expectedSchemaVersion: 3 },
      fields: [{
        fieldId: nameFieldId, label: "Customer name", type: "text",
        required: true, maxLength: 100, options: [],
      }],
      fileRequests: [],
      encryption: {
        algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
        ownerPublicKey: input.publicKey,
      },
      delivery: { expiresAt: input.expiresAt },
    },
    relayBaseUrl: "https://relay.example.test/",
    publishedAt: new Date(Date.parse(input.expiresAt) - 86_400_000).toISOString(),
    revokedAt: null,
  };
  const key = JSON.stringify([1, "https://app.example.test", appInstanceId, target.activeGenerationId, target.lineageEpoch, "https://relay.example.test", form.publicForm.formId]);
  custody.set(key, { schema: 1, key, shellOrigin: "https://app.example.test", form,
    ownerPrivateKey: input.privateKey, ownerToken: mintIntakeToken(), submitToken: mintIntakeToken() });
  return form;
}

describe("public intake UI", () => {
  it.each(["ledger", "legacy"])("requires explicit %s revoke recovery review and preserves the original invocation", async mode => {
    const keys = await generateIntakeOwnerKeyPair();
    let form = publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey, formId: `form_${"r".repeat(26)}`,
      title: "Original revoke", submitToken: "unused", ownerToken: "unused", expiresAt: "2030-01-01T00:00:00.000Z" });
    const worker = protocol({ listIntakeForms: async () => [form], intakeInbox: async () => [], intakeReceipts: async () => [], intakeDeliveryFailures: async () => [],
      recordIntakeDeliveryFailure: async () => null,
      revokeIntakeForm: async (_id, at) => { form = { ...form, revokedAt: at, terminalReason: "revoked" }; return form; } });
    const session = new IntakeSession(sessionStorage, worker, appInstanceId); await session.read();
    const original = session.begin("intake.revokeForm", { formId: form.publicForm.formId, revokedAt: "2026-09-13T12:00:00.000Z" });
    const job = { schema: 1 as const, form, intent: original, relayConfirmed: false };
    if (mode === "legacy") sessionStorage.setItem(`clay_intake_revocation_v1:${appInstanceId}`, JSON.stringify(job));
    else { const slot = new IntakeWorkflowSlot(workflows, sessionStorage, location.origin, appInstanceId, "revocation"); await slot.recover(); await slot.persist(job); }
    await worker.intakeCommand({ authorityTarget: target, command: { route: "intake.recordDeliveryFailure", payload: {} } }, worker.createMutationContext());
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schema: 1, formId: request.formId, expiresAt: request.expiresAt, requestSha256: await relayRequestSha256(request), terminal: true }));
    });
    const errors: string[] = []; const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
    const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === text)!;
    try {
      await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables} semanticTrace={semanticTrace}
        relayBaseUrl="https://relay.example.test" publicBaseUrl={location.origin} fetchImpl={fetchImpl} onClose={() => {}} onError={message => errors.push(message)} onInfo={() => {}} />));
      await flush();
      if (mode === "legacy") {
        expect(document.body.textContent).not.toContain("Resume original revocation");
        await act(async () => button("Review legacy revocation recovery").click());
        await waitForUi(() => !!button("Confirm original-owner recovery"));
        await act(async () => button("Confirm original-owner recovery").click());
        await waitForUi(() => !!button("Resume original revocation") && !button("Review revocation recovery").matches(":disabled"));
      }
      expect(form.revokedAt).toBeNull(); expect(fetchImpl).not.toHaveBeenCalled();
      await act(async () => button("Review revocation recovery").click());
      await waitForUi(() => !!button("Confirm renewed local revocation"));
      await act(async () => button("Confirm renewed local revocation").click());
      await waitForUi(() => !!button("Review form") && !button("Review form").matches(":disabled"));
      expect(errors).toEqual([]); expect(form.terminalReason).toBe("revoked"); expect(custody.size).toBe(1);
      expect((await worker.mutationOutcome(original.route, original.payload, { requestId: original.requestId })).status).toBe("cancelled");
    } finally { await act(async () => root.unmount()); }
  });
  it.each(["ledger", "legacy", "stale_closure"])("recovers %s interrupted publication and requires confirmation before closing the exact original work", async mode => {
    let forms: LocalIntakeFormV2[] = [], closureFailed = false;
    const worker = protocol({ listIntakeForms: async () => forms, intakeInbox: async () => [], intakeReceipts: async () => [], intakeDeliveryFailures: async () => [],
      saveIntakeForm: async form => { forms = [form]; return form; }, closeIntakePublication: async form => {
        if (mode === "stale_closure" && !closureFailed) { closureFailed = true; throw new Error("Owned closure needs recovery"); }
        return { schema: 1, form, terminal: true, closedAt: new Date().toISOString() };
      } });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).endsWith("/terminalize")) throw new Error("Owned publication response loss");
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schema: 1, formId: request.formId, expiresAt: request.expiresAt, requestSha256: await relayRequestSha256(request), terminal: true }));
    });
    const session = new IntakeSession(sessionStorage, worker, appInstanceId); await session.read();
    const publication = new IntakePublication(session, vault, { shellOrigin: location.origin, publicBaseUrl: location.origin, relayBaseUrl: "https://relay.example.test/" }, fetchImpl, workflows);
    await publication.recover(); await publication.begin({ title: "Original draft", description: "", target: { tableId, expectedSchemaVersion: 3 }, expiresAt: "2030-01-01T00:00:00.000Z",
      fields: [{ fieldId: nameFieldId, label: "Name", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] });
    await expect(publication.resume().then(() => "published")).rejects.toThrow(/uncertain/);
    const original = publication.pending()!;
    if (mode === "ledger") sessionStorage.clear(); else workflows = new IndexedDbIntakeWorkflows(new OwnedFactory() as unknown as IDBFactory);
    if (mode === "stale_closure") {
      const recovered = new IntakePublication(session, vault, { shellOrigin: location.origin, publicBaseUrl: location.origin, relayBaseUrl: "https://relay.example.test/" }, fetchImpl, workflows);
      await expect(recovered.terminalizeLegacy()).rejects.toThrow(/closure/); sessionStorage.clear();
    }
    const errors: string[] = []; const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
    const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === text)!;
    try {
      await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables} semanticTrace={semanticTrace}
        relayBaseUrl="https://relay.example.test" publicBaseUrl={location.origin} fetchImpl={fetchImpl} onClose={() => {}} onError={message => errors.push(message)} onInfo={() => {}} />));
      await flush();
      if (mode === "ledger") expect(document.body.textContent).toContain("Resume original publication");
      else expect(document.body.textContent).not.toContain("Resume original publication");
      if (mode === "stale_closure") {
        await act(async () => button("Review closure recovery").click());
        await waitForUi(() => !!button("Confirm renewed publication closure")); expect(fetchImpl).toHaveBeenCalledTimes(1);
        await act(async () => button("Confirm renewed publication closure").click());
      } else {
        await act(async () => button("Close original publication").click()); expect(fetchImpl).toHaveBeenCalledTimes(1);
        await act(async () => button("Confirm close original publication").click());
      }
      await waitForUi(() => !!button("Review form") && !button("Review form").matches(":disabled"));
      expect(errors).toEqual([]); expect(document.body.textContent).not.toContain("Resume original publication");
      expect(forms).toHaveLength(1); expect(forms[0]!.publicForm.formId).toBe(original.formId); expect(forms[0]!.publishedAt).toBeNull(); expect(custody.size).toBe(1);
      expect((await worker.mutationOutcome(original.publish!.route, original.publish!.payload, { requestId: original.publish!.requestId })).status).toBe("cancelled");
    } finally { await act(async () => root.unmount()); }
  });
  it("binds auto-accept enable to the exact simulation receipt, not a later presentation read", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    const form = publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
      formId: `form_${"p".repeat(26)}`, title: "Reviewed rule", submitToken: "unused", ownerToken: "unused", expiresAt: "2099-10-01T00:00:00.000Z" });
    const simulatedTarget = { ...target, protectionRevision: "2" };
    const newerTarget = { ...target, protectionRevision: "3" };
    let simulated = false; let serial = 0; const calls: any[] = [];
    const results = new Map<string, unknown>();
    const worker = {
      createMutationContext: () => ({ requestId: `req_${String.fromCharCode(97 + ++serial).repeat(26)}` }),
      intakePresentation: async () => ({ authorityTarget: simulated ? newerTarget : target, legacyCustody: "none", forms: [form], rules: [], inbox: [], receipts: [], deliveryFailures: [], tables, trace: semanticTrace }),
      mutationOutcome: async (_route: string, _payload: unknown, context: { requestId: string }) => results.get(context.requestId) ?? { status: "not_invoked" },
      intakeCommand: async (payload: any, context: { requestId: string }) => {
        calls.push(structuredClone(payload));
        if (payload.command.route === "intake.enableAutoAccept") throw new Error("Owned intervening-write rejection");
        simulated = true;
        const result = { fingerprint: "d".repeat(64), pendingCount: 1, matchedSubmissionIds: [`sub_${"q".repeat(26)}`] };
        results.set(context.requestId, { status: "recorded", current: false, result, target: simulatedTarget }); return result;
      },
    } as unknown as WorkerClient;
    const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
    const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === text)!;
    try {
      await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables} semanticTrace={semanticTrace}
        relayBaseUrl="https://relay.example.test" publicBaseUrl="https://app.example.test" onClose={() => {}} onError={() => {}} onInfo={() => {}} />));
      await waitForUi(() => !!button("Preview auto-accept") && !button("Preview auto-accept").matches(":disabled"));
      await act(async () => button("Preview auto-accept").click());
      await waitForUi(() => !!button("Enable this exact rule"));
      await act(async () => button("Enable this exact rule").click()); await flush();
      expect(calls).toHaveLength(2);
      expect(calls[1].authorityTarget).toEqual(simulatedTarget);
      expect(calls[1].command.payload.draft).toEqual(calls[0].command.payload.draft);
    } finally { await act(async () => root.unmount()); }
  });

  it("keeps retained publication recovery visible when relay configuration disappears", async () => {
    const retained = "owned opaque incomplete intent";
    sessionStorage.setItem(`clay_intake_publication_v1:${appInstanceId}`, retained);
    const worker = protocol({ listIntakeForms: async () => [], intakeInbox: async () => [], intakeReceipts: async () => [], intakeDeliveryFailures: async () => [] });
    const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables} semanticTrace={semanticTrace}
        relayBaseUrl={null} publicBaseUrl="https://app.example.test" onClose={() => {}} onError={() => {}} onInfo={() => {}} />));
      await flush();
      expect(document.body.textContent).toContain("Retained intake work needs its original source and configuration");
      expect(sessionStorage.getItem(`clay_intake_publication_v1:${appInstanceId}`)).toBe(retained);
    } finally { await act(async () => root.unmount()); }
  });

  it("presents copied owner metadata as read-only instead of advertising another app's capabilities", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    const original = publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
      formId: `form_${"r".repeat(26)}`, title: "Copied form", submitToken: "unused", ownerToken: "unused", expiresAt: "2099-10-01T00:00:00.000Z" });
    const copied = { ...original, ownerSource: { ...original.ownerSource, appInstanceId: `app_${"z".repeat(26)}` } };
    const worker = protocol({ listIntakeForms: async () => [copied], intakeInbox: async () => [], intakeReceipts: async () => [], intakeDeliveryFailures: async () => [] });
    const host = document.createElement("div"); document.body.replaceChildren(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables} semanticTrace={semanticTrace}
        relayBaseUrl="https://relay.example.test" publicBaseUrl="https://app.example.test" onClose={() => {}} onError={() => {}} onInfo={() => {}} />));
      await flush();
      expect(document.body.textContent).toContain("Copied form metadata is read-only");
      expect([...document.body.querySelectorAll<HTMLButtonElement>("button")].some(row => ["Show public link", "Revoke", "Preview auto-accept"].includes(row.textContent ?? "") && !row.disabled)).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });

  it("uses the shared modal contract for portal isolation, focus containment, Escape, and restoration", async () => {
    const visibleRects = vi.spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue({ length: 1, item: () => null, [Symbol.iterator]: function* () { /* visible */ } } as DOMRectList);
    const worker = protocol({
      listIntakeForms: async () => [], intakeInbox: async () => [],
      intakeReceipts: async () => [], intakeDeliveryFailures: async () => [],
    });
    function Probe(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return <div className="app">
        <button onClick={() => setOpen(true)}>Open public intake</button>
        {open ? <IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables} semanticTrace={semanticTrace}
          relayBaseUrl="https://relay.example.test" publicBaseUrl="https://app.example.test"
          onClose={() => setOpen(false)} onError={() => undefined} onInfo={() => undefined} /> : null}
      </div>;
    }
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Probe />));
      const trigger = document.body.querySelector<HTMLButtonElement>(".app > button")!;
      trigger.focus();
      await act(async () => trigger.click());
      await flush();
      const app = document.body.querySelector<HTMLElement>(".app")!;
      const backdrop = document.body.querySelector<HTMLElement>(".intake-backdrop")!;
      const dialog = document.body.querySelector<HTMLElement>(".intake-center")!;
      expect(backdrop.parentElement).toBe(document.body);
      expect(app.inert).toBe(true);
      expect(app.getAttribute("aria-hidden")).toBe("true");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.contains(document.activeElement)).toBe(true);

      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]",
      )];
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      last.focus();
      await act(async () => void last.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab", bubbles: true, cancelable: true,
      })));
      expect(document.activeElement).toBe(first);

      await act(async () => void dialog.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      })));
      expect(document.body.querySelector(".intake-center")).toBeNull();
      expect(app.inert).toBe(false);
      expect(app.hasAttribute("aria-hidden")).toBe(false);
      expect(document.activeElement).toBe(trigger);
    } finally {
      await act(async () => root.unmount());
      visibleRects.mockRestore();
    }
  });

  it("refreshes published forms independently and reconciles local expiry despite a relay error", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    let forms = [
      publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
        formId: "form_aaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Unavailable form",
        submitToken: "a".repeat(43), ownerToken: "d".repeat(43),
        expiresAt: "2099-10-01T00:00:00.000Z" }),
      publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
        formId: "form_bbbbbbbbbbbbbbbbbbbbbbbbbb", title: "Expired form",
        submitToken: "b".repeat(43), ownerToken: "e".repeat(43),
        expiresAt: "2000-10-01T00:00:00.000Z" }),
      publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
        formId: "form_cccccccccccccccccccccccccc", title: "Healthy form",
        submitToken: "c".repeat(43), ownerToken: "f".repeat(43),
        expiresAt: "2099-10-01T00:00:00.000Z" }),
    ];
    const events: string[] = [];
    const errors: string[] = [];
    const worker = protocol({
      listIntakeForms: async () => forms,
      intakeInbox: async () => [], intakeReceipts: async () => [], intakeDeliveryFailures: async () => [],
      markIntakeFormExpired: async (formId: string, at: string) => {
        events.push(`expired:${formId}`);
        const index = forms.findIndex(form => form.publicForm.formId === formId);
        forms = forms.map((form, candidate) => candidate === index
          ? { ...form, revokedAt: at, terminalReason: "expired" as const } : form);
        return forms[index]!;
      },
      processIntakeAutoAccept: async () => [],
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); events.push(`fetch:${url}`);
      if (url.includes("form_aaaaaaaaaaaaaaaaaaaaaaaaaa"))
        return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ items: [], hasMore: false }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables}
      semanticTrace={semanticTrace} relayBaseUrl="https://relay.example.test"
      publicBaseUrl="https://app.example.test" fetchImpl={fetchImpl}
      onClose={() => undefined} onError={message => errors.push(message)} onInfo={() => undefined} />));
    await flush();
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.startsWith("Review inbox"))!.click());
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Refresh encrypted inbox")!.click());
    await flush();
    expect(events).toContain("expired:form_bbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(events.some(event => event.includes("form_cccccccccccccccccccccccccc"))).toBe(true);
    expect(events.some(event => event.startsWith("fetch:")
      && event.includes("form_bbbbbbbbbbbbbbbbbbbbbbbbbb"))).toBe(false);
    expect(errors).toEqual([expect.stringMatching(/1.*form.*could not be refreshed/i)]);
    await act(async () => root.unmount());
  });

  it("retains a missing relay response until an exact terminal receipt closes the original revocation", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    const form = publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
      formId: "form_aaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Customer request",
      submitToken: "a".repeat(43), ownerToken: "d".repeat(43),
      expiresAt: "2099-10-01T00:00:00.000Z" });
    let forms = [form];
    const revoked: string[] = [];
    const errors: string[] = [];
    const worker = protocol({
      listIntakeForms: async () => forms,
      intakeInbox: async () => [], intakeReceipts: async () => [], intakeDeliveryFailures: async () => [],
      revokeIntakeForm: async (formId: string, at: string) => {
        revoked.push(formId);
        forms = [{ ...form, revokedAt: at, terminalReason: "revoked" }];
        return forms[0]!;
      },
    });
    let terminal = false;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!terminal) return new Response("gone", { status: 410 });
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schema: 1, formId: request.formId, expiresAt: request.expiresAt,
        requestSha256: await relayRequestSha256(request), terminal: true }));
    });
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables}
      semanticTrace={semanticTrace} relayBaseUrl="https://relay.example.test"
      publicBaseUrl="https://app.example.test" fetchImpl={fetchImpl}
      onClose={() => undefined} onError={message => errors.push(message)} onInfo={() => undefined} />));
    await flush();
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Revoke")!.click());
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Confirm revocation")!.click());
    await flush();
    expect(revoked).toEqual([form.publicForm.formId]);
    expect(errors).toEqual([expect.stringMatching(/terminalization.*unconfirmed/i)]);
    expect(document.body.textContent).toContain("Resume original revocation");
    terminal = true;
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Resume original revocation")!.click());
    await flush();
    expect(revoked).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Resume original revocation");
    expect(document.body.textContent).toContain("Revoked");
    await act(async () => root.unmount());
  });

  it("exposes retry and confirmed discard recovery without deleting before durable local state", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    const form = publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
      formId: "form_aaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Customer request",
      submitToken: "a".repeat(43), ownerToken: "d".repeat(43),
      expiresAt: "2099-10-01T00:00:00.000Z" });
    const retryId = "sub_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const discardId = "sub_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let failures: IntakeDeliveryFailure[] = [retryId, discardId].map((submissionId, index) => ({
      formId: form.publicForm.formId, submissionId,
      envelopeSha256: String(index + 1).repeat(64), status: "failed",
      failedAt: "2026-09-08T12:00:00.000Z", updatedAt: "2026-09-08T12:00:00.000Z",
    }));
    const plaintext: IntakeSubmissionPlaintextV1 = {
      schema: 1, formId: form.publicForm.formId, formRevision: 1,
      submissionId: retryId, submittedAt: "2026-09-08T12:00:00.000Z",
      values: [{ fieldId: nameFieldId, value: "Ada Lovelace" }], files: [],
    };
    const encrypted = await encryptIntakeSubmission((await hydrateIntakeOwnerForm(form, target, "https://app.example.test", vault)).publicForm, plaintext);
    const events: string[] = [];
    const worker = protocol({
      listIntakeForms: async () => [form], intakeInbox: async () => [], intakeReceipts: async () => [],
      intakeDeliveryFailures: async () => failures,
      recordIntakeDeliveryFailure: async () => { throw new Error("unexpected decrypt failure"); },
      stageIntakeSubmission: async (submission: IntakeSubmissionPlaintextV1) => {
        events.push(`stage:${submission.submissionId}`);
        return { submissionId: submission.submissionId } as IntakeInboxItem;
      },
      authorizeIntakeDeliveryDiscard: async (formId: string, submissionId: string, at: string) => {
        events.push(`authorize:${submissionId}`);
        failures = failures.map(failure => failure.formId === formId && failure.submissionId === submissionId
          ? { ...failure, status: "discard_authorized", updatedAt: at } : failure);
        return failures.find(failure => failure.submissionId === submissionId)!;
      },
      resolveIntakeDeliveryFailure: async (
        _formId: string, submissionId: string, resolution: "staged" | "discarded",
      ) => {
        events.push(`resolve:${resolution}:${submissionId}`);
        failures = failures.filter(failure => failure.submissionId !== submissionId);
        return null;
      },
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        const id = url.split("/").at(-1)!; events.push(`delete:${id}`);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ items: [{
        schema: 1, formId: form.publicForm.formId, submissionId: retryId,
        receivedAt: "2026-09-08T12:00:00.000Z", expiresAt: "2099-10-08T12:00:00.000Z",
        ciphertextBytes: 100, envelope: encrypted.envelope,
      }], hasMore: false }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault} worker={worker} tables={tables}
      semanticTrace={semanticTrace} relayBaseUrl="https://relay.example.test"
      publicBaseUrl="https://app.example.test" fetchImpl={fetchImpl}
      onClose={() => undefined} onError={message => { throw new Error(message); }} onInfo={() => undefined} />));
    await flush();
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.startsWith("Review inbox"))!.click());
    expect(document.body.textContent).toContain("Encrypted delivery recovery");

    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Retry delivery")!.click());
    await flush();
    expect(events.slice(0, 3)).toEqual([
      `stage:${retryId}`, `resolve:staged:${retryId}`, `delete:${retryId}`,
    ]);

    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Discard delivery…")!.click());
    expect(events.some(event => event.includes(discardId))).toBe(false);
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Confirm permanent discard")!.click());
    await flush();
    const discardEvents = events.filter(event => event.includes(discardId));
    expect(discardEvents).toEqual([
      `authorize:${discardId}`, `delete:${discardId}`, `resolve:discarded:${discardId}`,
    ]);
    expect(document.body.textContent).not.toContain(discardId);
    await act(async () => root.unmount());
  });

  it("previews a stable-id form before registering the relay and saving publication authority", async () => {
    const events: string[] = [];
    const saved: LocalIntakeFormV2[] = [];
    const worker = protocol({
      listIntakeForms: async () => saved, intakeInbox: async () => [], intakeReceipts: async () => [],
      intakeDeliveryFailures: async () => [],
      saveIntakeForm: async (form: LocalIntakeFormV2) => {
        events.push("local-draft"); saved[0] = form; return form;
      },
      markIntakeFormPublished: async (_id: string, at: string) => {
        events.push("local-published"); saved[0] = { ...saved[0]!, publishedAt: at }; return saved[0]!;
      },
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push("ciphertext-relay-registration");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("ownerPrivateKey");
      return new Response(JSON.stringify({ formId: body.formId, expiresAt: body.expiresAt }), { status: 201 });
    });
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<IntakeCenter workflows={workflows} appInstanceId={appInstanceId} ownerVault={vault}
      worker={worker}
      tables={tables}
      semanticTrace={semanticTrace}
      relayBaseUrl="https://relay.example.test"
      publicBaseUrl="https://app.example.test"
      fetchImpl={fetchImpl}
      onClose={() => undefined}
      onError={message => { throw new Error(message); }}
      onInfo={() => undefined}
    />));
    await flush();
    const field = document.body.querySelector<HTMLInputElement>(`input[value="${nameFieldId}"]`)!;
    const fileRequest = document.body.querySelector<HTMLInputElement>(`input[value="${fileFieldId}"]`)!;
    await act(async () => { field.click(); fileRequest.click(); });
    const review = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Review form")!;
    expectControlCensus("F.intake");
    await act(async () => { review.click(); });
    expect(events).toEqual([]);
    expect(document.body.textContent).toContain("Nothing has been published yet");
    const publish = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Publish secure form")!;
    await act(async () => { publish.click(); });
    await flush();
    expect(events).toEqual(["local-draft", "ciphertext-relay-registration", "local-published"]);
    expect(saved[0]?.publicForm.target).toEqual({ tableId, expectedSchemaVersion: 3 });
    expect(saved[0]?.publicForm.fields.map(item => item.fieldId)).toEqual([nameFieldId]);
    expect(saved[0]?.publicForm.fileRequests).toEqual([expect.objectContaining({
      fieldId: fileFieldId,
      maxBytes: 200_000,
      allowedMimeTypes: ["image/png", "image/jpeg", "text/plain"],
    })]);
    const link = document.body.querySelector<HTMLInputElement>("input[readonly]")!.value;
    expect(link).toMatch(/^https:\/\/app\.example\.test\/intake#/);
    await act(async () => root.unmount());
  });

  it("submits only authenticated ciphertext while the owner can decrypt the entered value", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    const form = {
      schema: 1 as const,
      formId: "form_abcdefghijklmnopqrstuvwxyz",
      revision: 1,
      title: "Customer request",
      description: "Tell us what you need.",
      target: { tableId, expectedSchemaVersion: 3 },
      fields: [{ fieldId: nameFieldId, label: "Customer name", type: "text" as const,
        required: true, maxLength: 100, options: [] }],
      fileRequests: [],
      encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const,
        ownerPublicKey: keys.publicKey },
      delivery: { submitToken: "s".repeat(43), expiresAt: "2026-10-01T00:00:00.000Z" },
    };
    const payload: PublicIntakeLinkPayloadV1 = {
      schema: 1, relayBaseUrl: "https://relay.example.test", form,
    };
    let wireBody = "";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      wireBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    });
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<PublicIntakeForm payload={payload} fetchImpl={fetchImpl} />));
    const input = document.body.querySelector<HTMLInputElement>(`input[name="${nameFieldId}"]`)!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Ada Lovelace");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => { submit.click(); });
    await flush();
    expect(document.body.textContent).toContain("Sent securely");
    expect(wireBody).not.toContain("Ada Lovelace");
    const relay = JSON.parse(wireBody);
    const plaintext = await decryptIntakeSubmission(form, keys.privateKey, relay);
    expect(plaintext.values).toEqual([{ fieldId: nameFieldId, value: "Ada Lovelace" }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://relay.example.test/intake/forms/${form.formId}/submissions`,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${form.delivery.submitToken}` }) }),
    );
    await act(async () => root.unmount());
  });

  it("rejects active file content in the submitter browser before any relay request", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    const form = {
      schema: 1 as const,
      formId: "form_bcdefghijklmnopqrstuvwxyza",
      revision: 1,
      title: "Document request",
      description: "Upload a passive document.",
      target: { tableId, expectedSchemaVersion: 3 },
      fields: [{ fieldId: nameFieldId, label: "Customer name", type: "text" as const,
        required: true, maxLength: 100, options: [] }],
      fileRequests: [{
        requestId: "document", fieldId: fileFieldId, label: "Document", required: false,
        maxFiles: 1, maxBytes: 1024,
        allowedMimeTypes: ["application/pdf" as const],
      }],
      encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const,
        ownerPublicKey: keys.publicKey },
      delivery: { submitToken: "t".repeat(43), expiresAt: "2026-10-01T00:00:00.000Z" },
    };
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<PublicIntakeForm payload={{
      schema: 1, relayBaseUrl: "https://relay.example.test", form,
    }} fetchImpl={fetchImpl} />));
    const nameInput = document.body.querySelector<HTMLInputElement>(`input[name="${nameFieldId}"]`)!;
    const fileInput = document.body.querySelector<HTMLInputElement>('input[name="document"]')!;
    const bytes = new TextEncoder().encode("%PDF-1.7\n/J#61vaScript (owned)\n%%EOF");
    const hostileFile = {
      name: "hostile.pdf", type: "application/pdf", size: bytes.byteLength,
      arrayBuffer: async (): Promise<ArrayBuffer> => bytes.slice().buffer,
    } as File;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "Ada");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      Object.defineProperty(fileInput, "files", { configurable: true, value: [hostileFile] });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    await flush();
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toMatch(/not accepted without a complete passive-content scanner/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
