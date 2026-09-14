import { expect, it, vi } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { legacyIntakeHistory } from "../../kernel/test/helpers/legacy-intake-history";
import { generateIntakeOwnerKeyPair, encodeBase64Url } from "../src/intake/crypto";
import { IndexedDbIntakeOwnerVault } from "../src/intake/owner-custody.browser";
import { OwnedFactory } from "./helpers/owned-idb";

it.each(["none", "sealed_commit", "owner_commit", "readback"])("sealed legacy adoption preserves originals and retries the same custody after %s loss", async fault => {
  const f = await legacyIntakeHistory(async form => {
    const pair = await generateIntakeOwnerKeyPair(); return { ...form, ownerPrivateKey: pair.privateKey,
      ownerToken: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))), publicForm: { ...form.publicForm,
        encryption: { ...form.publicForm.encryption, ownerPublicKey: pair.publicKey }, delivery: { ...form.publicForm.delivery, submitToken: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))) } } };
  });
  try {
    const { receiveLegacyOwner } = await import("../src/legacy/owner-recovery");
    const { IndexedDbLegacyOwnerVault } = await import("../src/legacy/owner-vault.browser");
    const { sendLegacyOwner } = await import("../src/worker/legacy-owner-channel");
    const archive = new IndexedDbLegacyOwnerVault(new OwnedFactory() as unknown as IDBFactory), owner = new IndexedDbIntakeOwnerVault(new OwnedFactory() as unknown as IDBFactory);
    let fail = fault; const insert = archive.insert.bind(archive), ownerInsert = owner.insert.bind(owner), ownerRead = owner.read.bind(owner);
    vi.spyOn(archive, "insert").mockImplementation(async record => { await insert(record); if (fail === "sealed_commit") { fail = "none"; throw new Error("owned loss"); } });
    vi.spyOn(owner, "insert").mockImplementation(async record => { await ownerInsert(record); if (fail === "owner_commit") { fail = "none"; throw new Error("owned loss"); } });
    vi.spyOn(owner, "read").mockImplementation(async key => { if (fail === "readback") { fail = "none"; throw new Error("owned loss"); } return ownerRead(key); });
    const candidate = (await f.authority.legacyOwnerInventory(null)).candidates[0]!;
    const attempt = async () => {
      const channel = new MessageChannel();
      const receive = receiveLegacyOwner(channel.port1 as unknown as MessagePort, "https://app.example.test", archive, owner);
      const sender = sendLegacyOwner(f.authority, candidate, channel.port2 as unknown as MessagePort, "https://app.example.test");
      const results = await Promise.allSettled([receive, sender]);
      channel.port1.close(); channel.port2.close();
      if (results.some(result => result.status === "rejected")) throw new Error("Sealed custody remained retained");
      return (results[1] as PromiseFulfilledResult<unknown>).value;
    };
    if (fault !== "none") await expect(attempt()).rejects.toThrow(/retained/);
    const result = await attempt(); expect(JSON.stringify(result).includes("ownerPrivateKey")).toBe(false);
    expect((await archive.list()).length).toBe(1);
    const original = (await archive.list())[0]!; expect(original.proof.source).toEqual(f.source);
    expect(f.driver.select("SELECT value_json=? AS unchanged FROM sys.settings WHERE key='intake_v1'", [f.original])[0]?.unchanged).toBe(1);
    await expect(f.authority.collectArchiveSnapshot()).rejects.toThrow(/custody/);
  } finally { f.authority.close(); }
}, 30_000);

it.each(["origin", "ciphertext"])("rejects %s mismatch before custody publication and keeps original private bytes", async fault => {
  const f = await legacyIntakeHistory();
  try {
    const { receiveLegacyOwner } = await import("../src/legacy/owner-recovery");
    const { IndexedDbLegacyOwnerVault } = await import("../src/legacy/owner-vault.browser");
    const { sendLegacyOwner } = await import("../src/worker/legacy-owner-channel");
    const archive = new IndexedDbLegacyOwnerVault(new OwnedFactory() as unknown as IDBFactory), ownerFactory = new OwnedFactory();
    const owner = new IndexedDbIntakeOwnerVault(ownerFactory as unknown as IDBFactory), channel = new MessageChannel();
    const send = channel.port2.postMessage.bind(channel.port2);
    if (fault === "ciphertext") vi.spyOn(channel.port2, "postMessage").mockImplementation((value, transfer) => {
      if (value.ciphertext instanceof ArrayBuffer) {
        const bytes = new Uint8Array(value.ciphertext); if (!bytes.length) throw new Error("Owned ciphertext fixture is empty");
        bytes[0] = bytes[0]! ^ 1;
      }
      send(value, transfer as never);
    });
    const candidate = (await f.authority.legacyOwnerInventory(null)).candidates[0]!;
    try {
      const results = await Promise.allSettled([
        receiveLegacyOwner(channel.port1 as unknown as MessagePort, "https://app.example.test", archive, owner),
        sendLegacyOwner(f.authority, candidate, channel.port2 as unknown as MessagePort, fault === "origin" ? "https://different.example.test" : "https://app.example.test"),
      ]);
      expect(results.every(row => row.status === "rejected")).toBe(true); expect(await archive.list()).toHaveLength(0); expect(ownerFactory.rows.size).toBe(0);
    } finally { channel.port1.close(); channel.port2.close(); }
    expect(f.driver.select("SELECT value_json=? AS unchanged FROM sys.settings WHERE key='intake_v1'", [f.original])[0]?.unchanged).toBe(1);
  } finally { f.authority.close(); }
}, 30_000);

it("preserves a proven public response as history without minting missing private owner custody", async () => {
  const f = await legacyIntakeHistory();
  try {
    const { ownerPrivateKey: _private, ownerToken: _owner, ...old } = f.form;
    const { submitToken: _submit, ...delivery } = old.publicForm.delivery;
    const source = f.authority.inspectAuthority().target, requestId = f.authority.createRequestId();
    const form = { ...old, schema: 2, ownerSource: { appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId, lineageEpoch: source.lineageEpoch },
      publicForm: { ...old.publicForm, formId: `form_${"z".repeat(26)}`, delivery } };
    await f.authority.executeMutation({ requestId, route: "intake.command", payload: { authorityTarget: source, command: { route: "intake.saveForm", payload: { form } } } });
    const { receiveLegacyOwner } = await import("../src/legacy/owner-recovery");
    const { IndexedDbLegacyOwnerVault } = await import("../src/legacy/owner-vault.browser");
    const { sendLegacyOwner } = await import("../src/worker/legacy-owner-channel");
    const archive = new IndexedDbLegacyOwnerVault(new OwnedFactory() as unknown as IDBFactory), ownerFactory = new OwnedFactory();
    const owner = new IndexedDbIntakeOwnerVault(ownerFactory as unknown as IDBFactory), channel = new MessageChannel();
    const candidate = (await f.authority.legacyOwnerInventory(null)).candidates.find(row => row.receipt.requestId === requestId)!;
    try {
      const [proof] = await Promise.all([
        receiveLegacyOwner(channel.port1 as unknown as MessagePort, "https://app.example.test", archive, owner),
        sendLegacyOwner(f.authority, candidate, channel.port2 as unknown as MessagePort, "https://app.example.test"),
      ]);
      expect(proof.kind).toBe("intake_public"); expect(proof.activation).toBe("custody_only");
      expect(ownerFactory.rows.size).toBe(0);
      const rows = await archive.list(); expect(rows).toHaveLength(1); expect(rows[0]!.custodyCommitted).toBe(true);
      expect(new TextDecoder().decode(rows[0]!.bytes).match(/ownerPrivateKey|ownerToken|submitToken/)).toBeNull();
    } finally { channel.port1.close(); channel.port2.close(); }
  } finally { f.authority.close(); }
}, 30_000);
