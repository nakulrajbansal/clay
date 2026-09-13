import { describe, expect, it } from "vitest";
import type {
  PublicIntakeFormV1, IntakeSubmissionPlaintextV1, LocalIntakeFormV1,
} from "@clay/schema/intake";
import * as intakeClient from "../src/intake/client";
import { discardFailedIntakeDelivery, fetchAndStageIntake } from "../src/intake/client";
import {
  decryptIntakeSubmission,
  encryptIntakeSubmission,
  generateIntakeOwnerKeyPair,
} from "../src/intake/crypto";

function form(ownerPublicKey: string): PublicIntakeFormV1 {
  return {
    schema: 1,
    formId: "form_abcdefghijklmnopqrstuvwxyz",
    revision: 2,
    title: "Job request",
    description: "Describe the work.",
    target: {
      tableId: "tbl_018f0000-0000-7000-8000-000000000001",
      expectedSchemaVersion: 4,
    },
    fields: [{
      fieldId: "fld_018f0000-0000-7000-8000-000000000002",
      label: "Summary",
      type: "text",
      required: true,
      maxLength: 500,
      options: [],
    }],
    fileRequests: [],
    encryption: {
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
      ownerPublicKey,
    },
    delivery: {
      submitToken: "s".repeat(43),
      expiresAt: "2026-10-01T00:00:00.000Z",
    },
  };
}

function submission(): IntakeSubmissionPlaintextV1 {
  return {
    schema: 1,
    formId: "form_abcdefghijklmnopqrstuvwxyz",
    formRevision: 2,
    submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
    submittedAt: "2026-09-07T12:00:00.000Z",
    values: [{
      fieldId: "fld_018f0000-0000-7000-8000-000000000002",
      value: "CONFIDENTIAL: repair the kiln",
    }],
    files: [],
  };
}

describe("browser-side intake encryption", () => {
  it("round-trips only for the owner key and authenticates form/submission context", async () => {
    const owner = await generateIntakeOwnerKeyPair();
    const publicForm = form(owner.publicKey);
    const plaintext = submission();
    const relayed = await encryptIntakeSubmission(publicForm, plaintext);

    expect(relayed.submissionId).toBe(plaintext.submissionId);
    expect(JSON.stringify(relayed)).not.toContain("CONFIDENTIAL");
    await expect(decryptIntakeSubmission(publicForm, owner.privateKey, relayed))
      .resolves.toEqual(plaintext);

    const other = await generateIntakeOwnerKeyPair();
    await expect(decryptIntakeSubmission(publicForm, other.privateKey, relayed)).rejects.toThrow();
    await expect(decryptIntakeSubmission(publicForm, owner.privateKey, {
      ...relayed, submissionId: "sub_bcdefghijklmnopqrstuvwxyza",
    })).rejects.toThrow();

    const last = relayed.envelope.ciphertext.at(-1)!;
    const tampered = `${relayed.envelope.ciphertext.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    await expect(decryptIntakeSubmission(publicForm, owner.privateKey, {
      ...relayed, envelope: { ...relayed.envelope, ciphertext: tampered },
    })).rejects.toThrow();
  });

  it("quarantines one tampered delivery opaquely and continues to later valid items", async () => {
    const owner = await generateIntakeOwnerKeyPair();
    const publicForm = form(owner.publicKey);
    const localForm: LocalIntakeFormV1 = {
      schema: 1, publicForm, ownerPrivateKey: owner.privateKey,
      ownerToken: "o".repeat(43), relayBaseUrl: "https://relay.example.test/",
      publishedAt: "2026-09-07T11:00:00.000Z", revokedAt: null,
    };
    const first = await encryptIntakeSubmission(publicForm, submission());
    const secondPlaintext: IntakeSubmissionPlaintextV1 = {
      ...submission(), submissionId: "sub_bcdefghijklmnopqrstuvwxyza",
      values: [{ ...submission().values[0]!, value: "later valid delivery" }],
    };
    const second = await encryptIntakeSubmission(publicForm, secondPlaintext);
    const at = "2026-09-07T12:00:00.000Z";
    const expiresAt = "2026-09-14T12:00:00.000Z";
    const poisoned = {
      ...first,
      envelope: {
        ...first.envelope,
        ciphertext: `${first.envelope.ciphertext.slice(0, 4)}${
          first.envelope.ciphertext[4] === "A" ? "B" : "A"}${first.envelope.ciphertext.slice(5)}`,
      },
    };
    const failures: Array<Record<string, unknown>> = [];
    const staged: IntakeSubmissionPlaintextV1[] = [];
    const acknowledgements: string[] = [];
    const worker = {
      intakeDeliveryFailures: async () => failures,
      recordIntakeDeliveryFailure: async (failure: Record<string, unknown>) => {
        const persisted = { ...failure, status: "failed" };
        failures.push(persisted); return persisted;
      },
      resolveIntakeDeliveryFailure: async (formId: string, submissionId: string) => {
        const index = failures.findIndex(item => item.formId === formId
          && item.submissionId === submissionId);
        if (index >= 0) failures.splice(index, 1);
        return null;
      },
      stageIntakeSubmission: async (value: IntakeSubmissionPlaintextV1) => {
        staged.push(value);
        return { submissionId: value.submissionId };
      },
    };
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === "DELETE") {
        acknowledgements.push(String(input).split("/").at(-1)!);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({
        items: [poisoned, second].map(item => ({
          schema: 1, formId: publicForm.formId, submissionId: item.submissionId,
          receivedAt: at, expiresAt, ciphertextBytes: 100, envelope: item.envelope,
        })),
        hasMore: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await fetchAndStageIntake(
      worker as unknown as Parameters<typeof fetchAndStageIntake>[0],
      localForm,
      fetchImpl,
    );
    expect(result.map(item => item.submissionId)).toEqual([secondPlaintext.submissionId]);
    expect(staged).toEqual([secondPlaintext]);
    expect(acknowledgements).toEqual([secondPlaintext.submissionId]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      formId: publicForm.formId,
      submissionId: poisoned.submissionId,
      status: "failed",
    });
    expect(JSON.stringify(failures[0])).not.toContain(poisoned.envelope.ciphertext);
  });

  it("resumes a durably authorized discard after a relay failure without authorizing twice", async () => {
    const owner = await generateIntakeOwnerKeyPair();
    const publicForm = form(owner.publicKey);
    const localForm: LocalIntakeFormV1 = {
      schema: 1, publicForm, ownerPrivateKey: owner.privateKey,
      ownerToken: "o".repeat(43), relayBaseUrl: "https://relay.example.test/",
      publishedAt: "2026-09-07T11:00:00.000Z", revokedAt: null,
    };
    let failure = {
      formId: publicForm.formId, submissionId: submission().submissionId,
      envelopeSha256: "a".repeat(64), status: "failed" as "failed" | "discard_authorized",
      failedAt: "2026-09-07T12:00:00.000Z", updatedAt: "2026-09-07T12:00:00.000Z",
    };
    const events: string[] = [];
    const worker = {
      intakeDeliveryFailures: async () => [failure],
      authorizeIntakeDeliveryDiscard: async (_formId: string, _submissionId: string, at: string) => {
        if (failure.status !== "failed") throw new Error("discard was already authorized");
        events.push("authorize"); failure = { ...failure, status: "discard_authorized", updatedAt: at };
        return failure;
      },
      resolveIntakeDeliveryFailure: async () => { events.push("resolve"); return null; },
    };
    let deletes = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe("DELETE"); events.push("delete"); deletes += 1;
      return new Response(null, { status: deletes === 1 ? 503 : 204 });
    };

    await expect(discardFailedIntakeDelivery(
      worker as unknown as Parameters<typeof discardFailedIntakeDelivery>[0],
      localForm, failure.submissionId, fetchImpl,
    )).rejects.toThrow(/acknowledgement failed/i);
    expect(failure.status).toBe("discard_authorized");
    expect(events).toEqual(["authorize", "delete"]);

    await discardFailedIntakeDelivery(
      worker as unknown as Parameters<typeof discardFailedIntakeDelivery>[0],
      localForm, failure.submissionId, fetchImpl,
    );
    expect(events).toEqual(["authorize", "delete", "delete", "resolve"]);
  });

  it("retires transport-only lifecycle writers; production expiry/revocation use source-bound owner custody", () => {
    // Their former behavior is exercised through IntakeOwnerClient in the UI and
    // real-worker packets, not a private-form-to-worker compatibility shortcut.
    for (const name of ["createLocalIntakeForm", "publishIntakeForm", "refreshPublishedIntakeForms", "revokePublishedIntakeForm"])
      expect(typeof Reflect.get(intakeClient, name)).toBe("undefined");
  });
});
