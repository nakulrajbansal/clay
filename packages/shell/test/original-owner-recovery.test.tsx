/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://owner.example"} */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OriginalOwnerRecovery } from "../src/app/OriginalOwnerRecovery";
import { IndexedDbIntakeWorkflows, IntakeWorkflowSlot } from "../src/intake/workflows";
import { IntakePublication } from "../src/intake/publication";
import { OwnedFactory } from "./helpers/owned-idb";
import type { WorkerClient } from "../src/app/worker-client";
import type { IntakeOwnerWitnessV1 } from "@clay/schema/owner-witness";
import type { IntakePublicationJobV1 } from "@clay/schema/intake-workflow";
import type { LocalIntakeFormV2 } from "@clay/schema/intake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (prefix: string, c: string) => `${prefix}_${c.repeat(26)}`, hash = (c: string) => `sha256:${c.repeat(64)}`;
const source = { appInstanceId: id("app", "a"), activeGenerationId: id("gen", "b"), lineageEpoch: "0", protectionRevision: "1", digestSchema: 1 as const, stateSha256: hash("a") };
const proposal = { title: "Retained original", description: "", target: { tableId: "tbl_11111111-1111-7111-8111-111111111111", expectedSchemaVersion: 1 },
  fields: [{ fieldId: "fld_22222222-2222-7222-8222-222222222222", label: "Title", type: "text" as const, required: true, maxLength: 100, options: [] }], fileRequests: [], expiresAt: "2030-01-01T00:00:00.000Z" };
const form: LocalIntakeFormV2 = { schema: 2, ownerSource: { appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId, lineageEpoch: source.lineageEpoch },
  relayBaseUrl: "https://relay.example/", publishedAt: null, revokedAt: null, terminalReason: null,
  publicForm: { schema: 1, formId: id("form", "c"), revision: 1, title: proposal.title, description: "", target: proposal.target, fields: proposal.fields, fileRequests: [],
    delivery: { expiresAt: proposal.expiresAt }, encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: "A".repeat(87) } } };
const job: IntakePublicationJobV1 = { schema: 1, formId: form.publicForm.formId, source, proposal,
  configuration: { shellOrigin: location.origin, publicBaseUrl: location.origin, relayBaseUrl: form.relayBaseUrl },
  save: { schema: 1, appInstanceId: source.appInstanceId, slot: "intake", route: "intake.command", requestId: id("req", "d"), payload: {
    authorityTarget: source, command: { route: "intake.saveForm", payload: { form } } } },
  publish: null, complete: null, relayConfirmed: false, relayInvoked: false };
const at = "2026-09-13T12:00:00.000Z";
const witness: IntakeOwnerWitnessV1 = { schema: 1, status: "deleted", authorityIncarnationId: id("auth", "e"), catalogGeneration: "10",
  claim: { schema: 1, requestId: job.save!.requestId, source, form },
  receipt: { schema: 1, requestId: job.save!.requestId, operationId: id("op", "f"), appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId,
    lineageEpoch: "0", expectedProtectionRevision: "1", expectedStateSha256: source.stateSha256, requestSha256: hash("b"), state: "committed",
    resultingProtectionRevision: "2", resultingStateSha256: hash("c"), responseSha256: hash("d"), preparedAt: at, invokedAt: at, completedAt: at },
  retirement: { schema: 2, kind: "delete", jobId: id("job", "g"), authorityIncarnationId: id("auth", "e"), requestId: id("req", "h"), requestSha256: hash("e"), operationId: id("op", "i"),
    requestedAppInstanceId: source.appInstanceId, resultingSelectedAppInstanceId: id("app", "j"), completedCatalogGeneration: "9", completedAt: at,
    resultTarget: { ...source, appInstanceId: id("app", "j") }, resultDisplayName: "Fallback", resultShellId: "blank" } };

it.each(["deleted", "history_only", "configuration_off"])("requires explicit original-owner review and keeps noneligible work closed (%s)", async mode => {
  const workflows = new IndexedDbIntakeWorkflows(new OwnedFactory() as unknown as IDBFactory), slot = new IntakeWorkflowSlot(workflows, sessionStorage, location.origin, source.appInstanceId, "publication");
  await slot.recover(); await slot.persist(job);
  const read = vi.fn(async () => mode === "history_only" ? { ...witness, status: "history_only", retirement: undefined } : structuredClone(witness));
  const close = vi.spyOn(IntakePublication.prototype, "closeDeletedOriginal").mockResolvedValue();
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  const click = async (label: string) => { await act(async () => { const button = [...element.querySelectorAll("button")].find(row => row.textContent === label); expect(button).toBeDefined(); button!.click(); }); };
  try {
    await act(async () => root.render(<OriginalOwnerRecovery worker={{ intakeOwnerWitness: read } as unknown as WorkerClient}
      relayBaseUrl={mode === "configuration_off" ? null : form.relayBaseUrl} publicBaseUrl={location.origin} workflows={workflows} />));
    await click("Inspect retained owner work"); expect(close).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    await click("Review original owner proof"); expect(read).toHaveBeenCalledWith(witness.claim); expect(close).not.toHaveBeenCalled();
    const confirm = [...element.querySelectorAll("button")].find(row => row.textContent === "Close this deleted original publication");
    if (mode !== "deleted") expect(confirm?.disabled ?? true).toBe(true);
    else { await click("Close this deleted original publication"); expect(close).toHaveBeenCalledWith(witness); }
  } finally { await act(async () => root.unmount()); element.remove(); close.mockRestore(); sessionStorage.clear(); } // Owned jsdom cache only.
});
