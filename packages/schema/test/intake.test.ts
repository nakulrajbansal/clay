import { describe, expect, it } from "vitest";
import {
  IntakeAutoAcceptDraftV1,
  IntakeAutoAcceptRuleV1,
  IntakeCiphertextEnvelopeV1,
  IntakeRelayDeliveryItemV1,
  IntakeRelayFormRegistrationV1,
  IntakeRelaySubmissionV1,
  IntakeSubmissionPlaintextV1,
  LocalIntakeFormV1,
  PublicIntakeLinkPayloadV1,
  PublicIntakeFormV1,
} from "../src/intake";

const form = {
  schema: 1 as const,
  formId: "form_abcdefghijklmnopqrstuvwxyz",
  revision: 1,
  title: "Customer request",
  description: "Tell us what you need.",
  target: {
    tableId: "tbl_018f0000-0000-7000-8000-000000000001",
    expectedSchemaVersion: 3,
  },
  fields: [{
    fieldId: "fld_018f0000-0000-7000-8000-000000000002",
    label: "Name",
    type: "text" as const,
    required: true,
    maxLength: 120,
    options: [],
  }],
  fileRequests: [{
    requestId: "document",
    fieldId: "fld_018f0000-0000-7000-8000-000000000003",
    label: "Supporting document",
    required: false,
    maxFiles: 1,
    maxBytes: 1_000_000,
    allowedMimeTypes: ["application/pdf" as const],
  }],
  encryption: {
    algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const,
    ownerPublicKey: "A".repeat(87),
  },
  delivery: {
    submitToken: "s".repeat(43),
    expiresAt: "2026-10-01T00:00:00.000Z",
  },
};

describe("public intake form v1", () => {
  it("accepts only a bounded stable-id allowlist without authority fields", () => {
    expect(PublicIntakeFormV1.parse(form)).toEqual(form);
    expect(PublicIntakeFormV1.safeParse({ ...form, declared_writes: ["customers"] }).success)
      .toBe(false);
    expect(PublicIntakeFormV1.safeParse({
      ...form,
      fields: [...form.fields, { ...form.fields[0], fieldId: form.fields[0]!.fieldId }],
    }).success).toBe(false);
    expect(PublicIntakeFormV1.safeParse({
      ...form,
      fileRequests: [{ ...form.fileRequests[0], maxBytes: 5 * 1024 * 1024 + 1 }],
    }).success).toBe(false);
  });
});

describe("intake submission and relay envelopes", () => {
  const submission = {
    schema: 1 as const,
    formId: form.formId,
    formRevision: 1,
    submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
    submittedAt: "2026-09-07T12:00:00.000Z",
    values: [{
      fieldId: form.fields[0]!.fieldId,
      value: "Ada Lovelace",
    }],
    files: [{
      requestId: "document",
      uploadId: "upl_abcdefghijklmnopqrstuvwxyz",
      name: "request.pdf",
      mime: "application/pdf" as const,
      size: 4,
      sha256: "0".repeat(64),
      bytes: "JVBERg",
    }],
  };

  it("keeps plaintext, ciphertext, and deterministic auto-accept contracts closed and bounded", () => {
    expect(IntakeSubmissionPlaintextV1.parse(submission)).toEqual(submission);
    expect(IntakeSubmissionPlaintextV1.safeParse({
      ...submission,
      values: [...submission.values, submission.values[0]],
    }).success).toBe(false);

    const envelope = {
      schema: 1 as const,
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const,
      ephemeralPublicKey: "A".repeat(87),
      salt: "A".repeat(22),
      iv: "A".repeat(16),
      ciphertext: "AA",
    };
    expect(IntakeCiphertextEnvelopeV1.parse(envelope)).toEqual(envelope);
    expect(IntakeRelaySubmissionV1.parse({
      schema: 1, submissionId: submission.submissionId, envelope,
    })).toBeTruthy();
    expect(IntakeRelaySubmissionV1.safeParse({
      schema: 1, submissionId: submission.submissionId, envelope, plaintext: submission,
    }).success).toBe(false);

    const draft = {
      schema: 1 as const,
      formId: form.formId,
      formRevision: form.revision,
      expectedSchemaVersion: form.target.expectedSchemaVersion,
      conditions: [{ fieldId: form.fields[0]!.fieldId, op: "equals" as const, value: "Ada Lovelace" }],
    };
    expect(IntakeAutoAcceptDraftV1.parse(draft)).toEqual(draft);
    expect(IntakeAutoAcceptDraftV1.safeParse({
      ...draft,
      conditions: [{ ...draft.conditions[0], op: "regex", value: ".*" }],
    }).success).toBe(false);
  });
});

describe("relay delivery and local form authority contracts", () => {
  it("separates public submit capability from local owner and private-key authority", () => {
    const registration = {
      schema: 1 as const,
      formId: form.formId,
      ownerToken: "o".repeat(43),
      submitToken: form.delivery.submitToken,
      expiresAt: form.delivery.expiresAt,
      maxCiphertextBytes: 2 * 1024 * 1024,
    };
    expect(IntakeRelayFormRegistrationV1.parse(registration)).toEqual(registration);
    expect(IntakeRelayFormRegistrationV1.safeParse({
      ...registration, submitToken: registration.ownerToken,
    }).success).toBe(false);

    const local = {
      schema: 1 as const,
      publicForm: form,
      ownerPrivateKey: "A".repeat(184),
      ownerToken: registration.ownerToken,
      relayBaseUrl: "https://relay.example.test",
      publishedAt: null,
      revokedAt: null,
    };
    expect(LocalIntakeFormV1.parse(local)).toEqual(local);
    const link = { schema: 1 as const, relayBaseUrl: local.relayBaseUrl, form };
    expect(PublicIntakeLinkPayloadV1.parse(link)).toEqual(link);
    expect(PublicIntakeLinkPayloadV1.safeParse({
      ...link, relayBaseUrl: "http://relay.example.test",
    }).success).toBe(false);

    const rule = {
      schema: 1 as const,
      formId: form.formId,
      formRevision: form.revision,
      expectedSchemaVersion: form.target.expectedSchemaVersion,
      conditions: [{ fieldId: form.fields[0]!.fieldId, op: "is_present" as const, value: null }],
      enabled: true as const,
      simulationFingerprint: "1".repeat(64),
      simulatedAt: "2026-09-07T12:00:00.000Z",
      enabledAt: "2026-09-07T12:01:00.000Z",
    };
    expect(IntakeAutoAcceptRuleV1.parse(rule)).toEqual(rule);

    const envelope = {
      schema: 1 as const,
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const,
      ephemeralPublicKey: "A".repeat(87), salt: "A".repeat(22),
      iv: "A".repeat(16), ciphertext: "AA",
    };
    const item = {
      schema: 1 as const,
      formId: form.formId,
      submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
      receivedAt: "2026-09-07T12:00:00.000Z",
      expiresAt: "2026-09-14T12:00:00.000Z",
      ciphertextBytes: 1,
      envelope,
    };
    expect(IntakeRelayDeliveryItemV1.parse(item)).toEqual(item);
    expect(IntakeRelayDeliveryItemV1.safeParse({ ...item, plaintext: "secret" }).success)
      .toBe(false);
  });
});
