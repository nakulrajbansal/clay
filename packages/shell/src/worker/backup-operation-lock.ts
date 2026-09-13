import { ClayError } from "@clay/kernel/errors";

let ownedTestTail = Promise.resolve();
/** Trusted-shell coordination only; this never grants database or file authority. */
export async function withBackupTrustLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request("clay:backup-trust-publication:v1", { mode: "exclusive" }, work);
  if (typeof window !== "undefined")
    throw new ClayError("E_CATALOG_UNAVAILABLE", "Cross-tab backup exclusion is unavailable");
  const result = ownedTestTail.then(work);
  ownedTestTail = result.then(() => undefined, () => undefined);
  return result;
}
