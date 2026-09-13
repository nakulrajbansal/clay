import { expect, it, vi } from "vitest";
import { fetchAndStageIntake, type IntakeOwnerTransport } from "../src/intake/client";
import { encryptIntakeSubmission, generateIntakeOwnerKeyPair } from "../src/intake/crypto";
import type { IntakeSubmissionPlaintextV1 } from "@clay/schema/intake";

it.each(["malformed", "redirect", "acknowledgement", "wrong_form"])("keeps the owner delivery boundary closed on %s", async fault => {
  const keys = await generateIntakeOwnerKeyPair(); const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
  const form: IntakeOwnerTransport = { ownerPrivateKey: keys.privateKey, ownerToken: "o".repeat(43), relayBaseUrl: "https://relay.example.test",
    publishedAt: "2026-09-13T12:00:00.000Z", revokedAt: null, publicForm: { schema: 1, formId: id("form", "a"), revision: 1,
      title: "Owned request", description: "", target: { tableId: "tbl_11111111-1111-7111-8111-111111111111", expectedSchemaVersion: 1 },
      fields: [{ fieldId: "fld_22222222-2222-7222-8222-222222222222", label: "Name", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [],
      encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: keys.publicKey },
      delivery: { submitToken: "s".repeat(43), expiresAt: "2026-10-01T00:00:00.000Z" } } };
  const body: IntakeSubmissionPlaintextV1 = { schema: 1, formId: form.publicForm.formId, formRevision: 1, submissionId: id("sub", "b"),
    submittedAt: "2026-09-13T12:00:00.000Z", values: [{ fieldId: form.publicForm.fields[0]!.fieldId, value: "Owned answer" }], files: [] };
  const encrypted = await encryptIntakeSubmission(form.publicForm, body);
  const stage = vi.fn(async () => ({ submissionId: body.submissionId }));
  const worker = { intakeDeliveryFailures: async () => [], stageIntakeSubmission: stage, resolveIntakeDeliveryFailure: async () => null } as unknown as Parameters<typeof fetchAndStageIntake>[0];
  const calls: RequestInit[] = []; const reflectedMarker = "owned-remote-body-marker";
  const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    if (init?.method === "DELETE") {
      expect(stage).toHaveBeenCalledTimes(1);
      return new Response(null, { status: fault === "acknowledgement" ? 503 : 204 });
    }
    if (fault === "malformed") return new Response(reflectedMarker);
    return new Response(JSON.stringify({ hasMore: false, items: [{ schema: 1, formId: fault === "wrong_form" ? id("form", "z") : body.formId,
      submissionId: body.submissionId, receivedAt: body.submittedAt, expiresAt: form.publicForm.delivery.expiresAt, ciphertextBytes: 1000, envelope: encrypted.envelope }] }));
  };
  let message: string | null = null;
  try { await fetchAndStageIntake(worker, form, fetchImpl); }
  catch (error) { message = error instanceof Error ? error.message : "unknown"; }
  if (fault === "redirect") expect(calls.every(call => call.redirect === "error" && call.credentials === "omit")).toBe(true);
  else if (fault === "malformed") {
    expect(message?.includes(reflectedMarker)).toBe(false);
    expect(message).toMatch(/malformed|byte bound/); expect(stage).not.toHaveBeenCalled();
  } else if (fault === "acknowledgement") {
    expect(message).toMatch(/acknowledgement/); expect(stage).toHaveBeenCalledTimes(1);
  } else {
    expect(message).toMatch(/original form/); expect(stage).not.toHaveBeenCalled(); expect(calls).toHaveLength(1);
  }
});
