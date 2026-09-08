/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type {
  IntakeDeliveryFailure, IntakeInboxItem, RegTable, SemanticSchemaTraceV1,
} from "@clay/kernel";
import type {
  IntakeSubmissionPlaintextV1, LocalIntakeFormV1, PublicIntakeLinkPayloadV1,
} from "@clay/schema/intake";
import { IntakeCenter } from "../src/app/IntakeCenter";
import { PublicIntakeForm } from "../src/intake/PublicIntakeForm";
import {
  decryptIntakeSubmission, encryptIntakeSubmission, generateIntakeOwnerKeyPair,
} from "../src/intake/crypto";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tableId = "tbl_018f0000-0000-7000-8000-000000000001";
const nameFieldId = "fld_018f0000-0000-7000-8000-000000000002";
const fileFieldId = "fld_018f0000-0000-7000-8000-000000000003";
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

function publishedForm(input: {
  publicKey: string;
  privateKey: string;
  formId: string;
  title: string;
  submitToken: string;
  ownerToken: string;
  expiresAt: string;
}): LocalIntakeFormV1 {
  return {
    schema: 1,
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
      delivery: { submitToken: input.submitToken, expiresAt: input.expiresAt },
    },
    ownerPrivateKey: input.privateKey,
    ownerToken: input.ownerToken,
    relayBaseUrl: "https://relay.example.test/",
    publishedAt: new Date(Date.parse(input.expiresAt) - 86_400_000).toISOString(),
    revokedAt: null,
  };
}

describe("public intake UI", () => {
  it("uses the shared modal contract for portal isolation, focus containment, Escape, and restoration", async () => {
    const visibleRects = vi.spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue({ length: 1, item: () => null, [Symbol.iterator]: function* () { /* visible */ } } as DOMRectList);
    const worker = {
      listIntakeForms: async () => [], intakeInbox: async () => [],
      intakeReceipts: async () => [], intakeDeliveryFailures: async () => [],
    } as unknown as WorkerClient;
    function Probe(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return <div className="app">
        <button onClick={() => setOpen(true)}>Open public intake</button>
        {open ? <IntakeCenter worker={worker} tables={tables} semanticTrace={semanticTrace}
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
      await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab", bubbles: true, cancelable: true,
      })));
      expect(document.activeElement).toBe(first);

      await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
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
    const worker = {
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
    } as unknown as WorkerClient;
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
    await act(async () => root.render(<IntakeCenter worker={worker} tables={tables}
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

  it("treats a terminal relay response as successful owner revocation", async () => {
    const keys = await generateIntakeOwnerKeyPair();
    const form = publishedForm({ publicKey: keys.publicKey, privateKey: keys.privateKey,
      formId: "form_aaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Customer request",
      submitToken: "a".repeat(43), ownerToken: "d".repeat(43),
      expiresAt: "2099-10-01T00:00:00.000Z" });
    let forms = [form];
    const revoked: string[] = [];
    const errors: string[] = [];
    const worker = {
      listIntakeForms: async () => forms,
      intakeInbox: async () => [], intakeReceipts: async () => [], intakeDeliveryFailures: async () => [],
      revokeIntakeForm: async (formId: string, at: string) => {
        revoked.push(formId);
        forms = [{ ...form, revokedAt: at, terminalReason: "revoked" }];
        return forms[0]!;
      },
    } as unknown as WorkerClient;
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 410 }));
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<IntakeCenter worker={worker} tables={tables}
      semanticTrace={semanticTrace} relayBaseUrl="https://relay.example.test"
      publicBaseUrl="https://app.example.test" fetchImpl={fetchImpl}
      onClose={() => undefined} onError={message => errors.push(message)} onInfo={() => undefined} />));
    await flush();
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Revoke")!.click());
    await flush();
    expect(revoked).toEqual([form.publicForm.formId]);
    expect(errors).toEqual([]);
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
    const encrypted = await encryptIntakeSubmission(form.publicForm, plaintext);
    const events: string[] = [];
    const worker = {
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
    } as unknown as WorkerClient;
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
    await act(async () => root.render(<IntakeCenter worker={worker} tables={tables}
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
    const saved: LocalIntakeFormV1[] = [];
    const worker = {
      listIntakeForms: async () => [], intakeInbox: async () => [], intakeReceipts: async () => [],
      intakeDeliveryFailures: async () => [],
      saveIntakeForm: async (form: LocalIntakeFormV1) => {
        events.push("local-draft"); saved[0] = form; return form;
      },
      markIntakeFormPublished: async (_id: string, at: string) => {
        events.push("local-published"); saved[0] = { ...saved[0]!, publishedAt: at }; return saved[0]!;
      },
    } as unknown as WorkerClient;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push("ciphertext-relay-registration");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("ownerPrivateKey");
      return new Response(JSON.stringify({ formId: body.formId }), { status: 201 });
    });
    const host = document.createElement("div"); document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => root.render(<IntakeCenter
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
      maxBytes: 5 * 1024 * 1024,
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
