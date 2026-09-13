import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import type { ReviewedImportFile } from "./ImportReview";
import type { WorkerMutationContext } from "./worker-client";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type SetupChoice = {
  kind: "starter" | "import"; sourceAppInstanceId: string; createsApp: boolean;
  displayName: string; shellId: string;
  reviewed: { fileName: string; displayName: string; parsed: ReviewedImportFile } | null;
};
export type AppSetupIntent = SetupChoice & {
  schema: 1;
  createRequestId: string; nameRequestId: string; applyRequestId: string; undoRequestId: string;
  targetAppInstanceId: string | null;
  firstRunTarget: TargetEvidenceV1 | null;
  stage: "target" | "apply" | "committed";
};
const key = "clay_pending_app_setup_v1";
const requestId = /^req_[a-z2-7]{26}$/;
const appId = /^app_[a-z2-7]{26}$/;
export function readAppSetup(storage: Storage): AppSetupIntent | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > 8_000_000) throw new Error("Pending setup exceeds the retry limit.");
  const value = JSON.parse(raw) as AppSetupIntent;
  if (!value || value.schema !== 1 || !["starter", "import"].includes(value.kind)
      || !["target", "apply", "committed"].includes(value.stage) || !appId.test(value.sourceAppInstanceId)
      || (value.targetAppInstanceId !== null && !appId.test(value.targetAppInstanceId))
      || typeof value.createsApp !== "boolean" || typeof value.displayName !== "string" || typeof value.shellId !== "string"
      || ![value.createRequestId, value.nameRequestId, value.applyRequestId, value.undoRequestId].every(id => requestId.test(id)))
    throw new Error("The pending app setup cannot be read safely. No app was changed.");
  return value;
}
const immutable = ({ targetAppInstanceId: _target, firstRunTarget: _binding, stage: _stage, ...request }: AppSetupIntent) => JSON.stringify(request);
export function saveAppSetup(storage: Storage, value: AppSetupIntent): void {
  const previous = readAppSetup(storage);
  if (previous && (immutable(previous) !== immutable(value)
      || (previous.targetAppInstanceId !== null && previous.targetAppInstanceId !== value.targetAppInstanceId)
      || (previous.firstRunTarget !== null && JSON.stringify(previous.firstRunTarget) !== JSON.stringify(value.firstRunTarget))))
    throw new Error("Pending app setup request is immutable.");
  storage.setItem(key, JSON.stringify(value));
  if (JSON.stringify(readAppSetup(storage)) !== JSON.stringify(value)) throw new Error("Pending setup failed retry read-back.");
}
export function beginAppSetup(storage: Storage, choice: SetupChoice, mint: () => WorkerMutationContext): AppSetupIntent {
  const existing = readAppSetup(storage);
  if (existing) {
    if (existing.kind !== choice.kind) throw new Error("Finish the pending app setup before starting another.");
    return existing;
  }
  const value: AppSetupIntent = { schema: 1, ...choice,
    createRequestId: mint().requestId, nameRequestId: mint().requestId,
    applyRequestId: mint().requestId, undoRequestId: mint().requestId,
    targetAppInstanceId: null, firstRunTarget: null, stage: "target" };
  saveAppSetup(storage, value);
  return value;
}
export function finishAppSetup(storage: Storage): void { storage.removeItem(key); }
