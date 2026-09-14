/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://app.example.test"} */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WorkerClient } from "../src/app/worker-client";
import { LegacyOwnerRecovery } from "../src/app/LegacyOwnerRecovery";
import { IndexedDbLegacyOwnerVault } from "../src/legacy/owner-vault.browser";
import { OwnedFactory } from "./helpers/owned-idb";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("makes unprovable V1/private history and old sharing a safe usable compatibility outcome without reading capabilities", async () => {
  const archive = new IndexedDbLegacyOwnerVault(new OwnedFactory() as unknown as IDBFactory), next = vi.fn(), share = vi.fn(), app = vi.fn();
  const legacyStorage = { length: 1, key: () => "clay_owner_share_receipts_v1", getItem: vi.fn(() => { throw new Error("Private value must not be inspected"); }) };
  const target = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1, stateSha256: `sha256:${"a".repeat(64)}` };
  const worker = { legacyOwnerInventory: vi.fn(async () => ({ schema: 1, target, legacyState: true, candidates: [], next: null, unproven: 1 })) } as unknown as WorkerClient;
  const element = document.createElement("div"), root = createRoot(element); document.body.append(element);
  try {
    await act(async () => root.render(<LegacyOwnerRecovery worker={worker} origin={location.origin} archive={archive} legacyStorage={legacyStorage}
      onNewIntake={next} onNewShare={share} onNewApp={app} />));
    await act(async () => [...element.querySelectorAll("button")].find(b => b.textContent === "Inspect legacy compatibility")!.click());
    expect(element.textContent).toMatch(/cannot be recovered automatically/i);
    expect(element.textContent).toMatch(/app remains usable/i);
    expect(element.textContent).toMatch(/old sharing receipts/i);
    expect(legacyStorage.getItem).not.toHaveBeenCalled();
    await act(async () => [...element.querySelectorAll("button")].find(b => b.textContent === "Create a new form")!.click()); expect(next).toHaveBeenCalledOnce();
    await act(async () => [...element.querySelectorAll("button")].find(b => b.textContent === "Create a new share")!.click()); expect(share).toHaveBeenCalledOnce();
    await act(async () => [...element.querySelectorAll("button")].find(b => b.textContent === "Create a separate app")!.click()); expect(app).toHaveBeenCalledOnce();
    expect([...element.querySelectorAll("button")].some(b => /delete|export.*private|take ownership/i.test(b.textContent ?? ""))).toBe(false);
  } finally { await act(async () => root.unmount()); element.remove(); }
});
