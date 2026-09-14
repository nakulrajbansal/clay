import { expect, it, vi } from "vitest";
import { legacyIntakeHistory } from "../../kernel/test/helpers/legacy-intake-history";
import { ProductionStoreAuthority } from "../../kernel/src/production-authority";
import { generateIntakeOwnerKeyPair, encodeBase64Url } from "../src/intake/crypto";
import { IndexedDbIntakeOwnerVault } from "../src/intake/owner-custody.browser";
import { IndexedDbLegacyOwnerVault } from "../src/legacy/owner-vault.browser";
import { activateLegacyOwner, adoptLegacyOwner, cancelLegacyActivation, legacyOwnerSummaries } from "../src/legacy/owner-recovery";
import { WorkerClient } from "../src/app/worker-client";
import { OwnedFactory } from "./helpers/owned-idb";

it.each(["response_loss", "delayed_cancel"])("real worker sealed custody, original metadata activation, %s, teardown and reload", async fault => {
  const f = await legacyIntakeHistory(async form => {
    const pair = await generateIntakeOwnerKeyPair(); return { ...form, ownerPrivateKey: pair.privateKey,
      ownerToken: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))), publicForm: { ...form.publicForm,
        encryption: { ...form.publicForm.encryption, ownerPublicKey: pair.publicKey }, delivery: { ...form.publicForm.delivery, submitToken: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))) } } };
  });
  const origin = "https://app.example.test", archiveFactory = new OwnedFactory(), ownerFactory = new OwnedFactory();
  let archive = new IndexedDbLegacyOwnerVault(archiveFactory as unknown as IDBFactory), owners = new IndexedDbIntakeOwnerVault(ownerFactory as unknown as IDBFactory);
  vi.spyOn(ProductionStoreAuthority, "bootBrowser").mockImplementation(async () => f.authority);
  const sent: any[] = []; let drop = false, dropped = false, hold = false, held: MessageEvent | null = null;
  const scope = { location: { origin }, onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: { id: number; ok: boolean }) => {
      if (drop && data.ok && sent.find(row => row.id === data.id)?.op === "intakeCommand") { drop = false; dropped = true; return; }
      queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent));
    } };
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: any, transfer: Transferable[] = []) => {
      sent.push(structuredClone(data)); const event = new MessageEvent("message", { data: structuredClone(data), ports: transfer.filter(value => value instanceof MessagePort) });
      if (hold && data.op === "intakeCommand") { hold = false; held = event; return; }
      queueMicrotask(() => scope.onmessage?.(event));
    }, terminate: () => {} };
  vi.stubGlobal("self", scope); let client = new WorkerClient(transport as unknown as Worker);
  try {
    const module = "../src/worker/db-worker.ts"; await import(`${module}?legacy-${fault}`);
    await client.boot({ requestedAppId: null, appCache: [] });
    const inventory = await client.legacyOwnerInventory(), candidate = inventory.candidates[0]!;
    await adoptLegacyOwner(client, candidate, origin, archive, owners);
    const summary = (await legacyOwnerSummaries(archive, origin))[0]!; expect(summary.custodyCommitted).toBe(true);
    expect((await client.intakePresentation()).forms).toHaveLength(0);
    if (fault === "response_loss") drop = true; else hold = true;
    const activation = activateLegacyOwner(client, summary.key, inventory.target, origin, archive, owners).then(() => "applied", () => "retained");
    if (fault === "response_loss") {
      await vi.waitFor(() => expect(dropped).toBe(true), { timeout: 10_000 }); client.terminate(); expect(await activation).toBe("retained");
      expect((await f.authority.intakePresentation()).forms).toHaveLength(1);
      const source = f.authority.inspectAuthority().target;
      await f.authority.executeMutation({ requestId: f.authority.createRequestId(), route: "intake.command", payload: { authorityTarget: source,
        command: { route: "intake.markPublished", payload: { formId: summary.proof.form.publicForm.formId, publishedAt: new Date().toISOString() } } } });
    } else {
      await vi.waitFor(() => expect(held !== null).toBe(true), { timeout: 10_000 });
      await client.setSetting("synthetic_source_change", 1, client.createMutationContext());
      await cancelLegacyActivation(client, summary.key, origin, archive);
      scope.onmessage!(held!); expect(await activation).toBe("retained");
      expect((await client.intakePresentation()).forms).toHaveLength(0);
    }
    const prior = (await archive.read(summary.key))!.actions[0]!.intent.requestId;
    await f.reopen(); await import(`${module}?legacy-${fault}-reopen`); client = new WorkerClient(transport as unknown as Worker);
    archive = new IndexedDbLegacyOwnerVault(archiveFactory as unknown as IDBFactory); owners = new IndexedDbIntakeOwnerVault(ownerFactory as unknown as IDBFactory);
    await client.boot({ requestedAppId: null, appCache: [] });
    await activateLegacyOwner(client, summary.key, await client.presentationSource(), origin, archive, owners);
    const after = (await archive.read(summary.key))!;
    expect(after.actions[0]!.intent.requestId).toBe(prior); expect(after.actions.at(-1)?.outcome).toBe("applied");
    expect(after.actions).toHaveLength(fault === "response_loss" ? 1 : 2);
    expect((await client.intakePresentation()).forms).toHaveLength(1);
    if (fault === "response_loss") expect((await client.intakePresentation()).forms[0]!.publishedAt !== null).toBe(true);
    expect(f.driver.select("SELECT value_json=? AS unchanged FROM sys.settings WHERE key='intake_v1'", [f.original])[0]?.unchanged).toBe(1);
    expect(JSON.stringify(sent).match(/ownerPrivateKey|ownerToken|submitToken|response_json|responseJson/)).toBeNull();
    const refused = new MessageChannel();
    try { await expect(client.transferLegacyOwner({ ...candidate, ownerToken: "synthetic" } as never, refused.port1)).rejects.toThrow(/public proof/); }
    finally { refused.port1.close(); refused.port2.close(); }
    await expect(f.authority.collectArchiveSnapshot()).rejects.toThrow(/custody/);
  } finally { client.terminate(); f.authority.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
}, 40_000);
