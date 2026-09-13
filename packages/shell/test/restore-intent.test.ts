import { expect, it } from "vitest";
import { beginRestoreIntent, readRestoreIntent, finishRestoreIntent } from "../src/app/restore-intent";
const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
const grant = { schema: 1 as const, kind: "authenticated_format5_restore_as_new" as const,
  validationId: id("restoreval", "c"), archiveFormat: 5 as const, cryptographicallyAuthenticated: true as const,
  authentication: { schema: 1 as const, kind: "cose_mac0_hmac_256_256" as const, authenticationVersion: 1 as const,
    keyId: "a".repeat(32), seriesId: "b".repeat(32), generation: "1" }, freshness: "unknown" as const,
  archiveSha256: `sha256:${"c".repeat(64)}`, archiveTarget: { appInstanceId: id("app", "a"), activeGenerationId: id("gen", "d"),
    lineageEpoch: "0", protectionRevision: "0", digestSchema: 1 as const, stateSha256: `sha256:${"d".repeat(64)}` },
  preservedAppInstanceId: id("app", "a"), destinationAppInstanceId: id("app", "b"), installMode: "new_app_only" as const,
  validatedAt: "2026-09-12T12:00:00.000Z" };
it("retains one immutable non-secret restore intent across presentation teardown and only releases its exact identity", () => {
  const items = new Map<string, string>();
  const storage = { getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
  const pending = beginRestoreIntent(storage, grant, () => ({ requestId: id("req", "e") }));
  expect(readRestoreIntent(storage)).toEqual(pending);
  expect(beginRestoreIntent(storage, grant, () => { throw new Error("must not mint again"); })).toEqual(pending);
  expect(() => beginRestoreIntent(storage, { ...grant, archiveSha256: `sha256:${"e".repeat(64)}` }, () => ({ requestId: id("req", "f") })))
    .toThrow(/immutable/);
  expect(() => finishRestoreIntent(storage, id("req", "f"))).toThrow();
  finishRestoreIntent(storage, pending.requestId);
  expect(readRestoreIntent(storage)).toBeNull();
});
