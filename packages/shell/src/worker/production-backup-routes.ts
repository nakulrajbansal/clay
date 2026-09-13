import { BackupPublicationRequestV1, BackupStageValidationV1 } from "@clay/schema/backup";
import { TargetEvidenceV1 } from "@clay/schema/catalog";
import type { ProductionStoreAuthority } from "@clay/kernel/worker-authority";
import { verifyArchiveThroughPort } from "./archive-verification-channel";

type Target = ReturnType<typeof TargetEvidenceV1.parse>;
type Stage = Extract<ReturnType<typeof BackupStageValidationV1.parse>, { status: "valid" }>;
const staged = new WeakMap<ProductionStoreAuthority, Map<string, { stage: Stage; bytes: number }>>();
const same = (left: Target, right: Target) => JSON.stringify(TargetEvidenceV1.parse(left)) === JSON.stringify(TargetEvidenceV1.parse(right));

export async function validateProductionBackup(
  authority: ProductionStoreAuthority, bytes: ArrayBuffer, expectedInput: unknown, verifier: MessagePort | undefined,
) {
  if (!(bytes instanceof ArrayBuffer)) { verifier?.close(); throw new Error("Archive bytes are required"); }
  const expected = TargetEvidenceV1.parse(expectedInput);
  if (!same(authority.inspectAuthority().target, expected)) throw new Error("Backup target changed; prepare a fresh backup");
  // The first operation on archive content is MAC verification in the shell.
  const verified = await verifyArchiveThroughPort(verifier, new Uint8Array(bytes));
  try {
    const evidence = await authority.inspectArchiveSnapshot(verified.payload);
    if (!same(evidence, expected) || !same(authority.inspectAuthority().target, expected))
      throw new Error("Backup target changed during validation");
    const result = BackupStageValidationV1.parse({ schema: 1, status: "valid", evidence,
      authentication: verified.authentication });
    if (result.status !== "valid") throw new Error("Backup verification failed");
    const ledger = staged.get(authority) ?? new Map();
    ledger.set(verified.archiveSha256, { stage: result, bytes: bytes.byteLength });
    while (ledger.size > 4) ledger.delete(ledger.keys().next().value!);
    staged.set(authority, ledger);
    return result;
  } finally { verified.payload.fill(0); }
}

export async function publishProductionBackup(authority: ProductionStoreAuthority, input: unknown) {
  const request = BackupPublicationRequestV1.parse(input);
  const proof = staged.get(authority)?.get(request.artifact.archiveSha256);
  if (!proof) {
    const record = (await authority.backupRecords()).find(item => item.backupId === request.artifact.backupId);
    if (record?.state === "valid" && same(record.evidence, authority.inspectAuthority().target)
        && JSON.stringify(Object.fromEntries(Object.keys(request.artifact).map(key => [key, Reflect.get(record, key)]))) === JSON.stringify(request.artifact))
      return authority.publishBackup(request);
  }
  if (!proof || proof.bytes !== request.artifact.byteLength
      || JSON.stringify(proof.stage.authentication) !== JSON.stringify(request.artifact.authentication)
      || !same(proof.stage.evidence, request.expected.target))
    throw new Error("Backup publication requires authenticated readback in this worker session");
  // Catalog publication is independently fenced and receipt-replayable. Keep
  // the bounded proof after publication for a lost-response retry.
  return authority.publishBackup(request);
}
