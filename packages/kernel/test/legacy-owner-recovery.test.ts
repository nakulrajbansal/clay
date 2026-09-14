import { expect, it, vi } from "vitest";
import { legacyIntakeHistory } from "./helpers/legacy-intake-history";
import { ProductionStoreAuthority, productionLifecycleContext } from "../src/production-authority";
import { sha256HexSync } from "../src/state-digest";

it("discovers only metadata, then privately proves original anchored bytes; V1 originals and archives stay unchanged", async () => {
  const f = await legacyIntakeHistory();
  try {
    const select = vi.spyOn(f.driver, "select"), before = f.authority.inspectAuthority();
    const inventory = await (f.authority as any).legacyOwnerInventory(null);
    expect(inventory.candidates).toHaveLength(1);
    expect(select.mock.calls.every(([sql]) => !/SELECT[^;]*\bresponse_json\s*(?:,|FROM)/i.test(sql))).toBe(true);
    const received: Uint8Array[] = [];
    const result = await (f.authority as any).withLegacyOwner(inventory.candidates[0], async (proof: unknown, raw: Uint8Array) => { received.push(raw.slice()); return proof; });
    expect(result.kind).toBe("intake_private"); expect(result.source).toEqual(f.source);
    expect(received.length).toBe(1); received[0]?.fill(0);
    expect(f.authority.inspectAuthority()).toEqual(before);
    expect(f.driver.select("SELECT value_json=? AS unchanged FROM sys.settings WHERE key='intake_v1'", [f.original])[0]?.unchanged).toBe(1);
    await expect(f.authority.collectArchiveSnapshot()).rejects.toThrow(/custody|legacy/i);
  } finally { f.authority.close(); }
});

it("keeps legacy intake isolated while allowing a new public V2 form in the original app", async () => {
  const f = await legacyIntakeHistory();
  try {
    const { ownerPrivateKey: _key, ownerToken: _token, ...old } = f.form;
    const { submitToken: _submit, ...delivery } = old.publicForm.delivery;
    const source = f.authority.inspectAuthority().target;
    const form = { ...old, schema: 2, ownerSource: { appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId, lineageEpoch: source.lineageEpoch },
      publicForm: { ...old.publicForm, formId: `form_${"z".repeat(26)}`, delivery } };
    await f.authority.executeMutation({ requestId: f.authority.createRequestId(), route: "intake.command", payload: { authorityTarget: source, command: { route: "intake.saveForm", payload: { form } } } });
    expect((await f.authority.intakePresentation()).forms).toHaveLength(1);
    expect(f.driver.select("SELECT value_json=? AS unchanged FROM sys.settings WHERE key='intake_v1'", [f.original])[0]?.unchanged).toBe(1);
  } finally { f.authority.close(); }
});

it.each(["malformed", "wrong_route", "digest", "unanchored", "copy"])("quarantines %s without exposing private bytes or replacing receipt identity", async fault => {
  const f = await legacyIntakeHistory();
  try {
    const inventory = await (f.authority as any).legacyOwnerInventory(null), claim = inventory.candidates[0];
    if (fault === "copy") claim.source.appInstanceId = `app_${"z".repeat(26)}`;
    else {
      const c = productionLifecycleContext(f.authority);
      c.writeAuthority.run(() => {
        if (fault === "unanchored") c.driver.exec("UPDATE sys.production_request_receipts SET operation_id=? WHERE request_id=?", [`op_${"z".repeat(26)}`, f.requestId]);
        else {
          const raw = fault === "malformed" ? "{" : fault === "wrong_route" ? "clay-response-v1:setting.set\n{}" : "{}";
          c.driver.exec("UPDATE sys.production_request_receipts SET response_json=? WHERE request_id=?", [raw, f.requestId]);
          if (fault !== "digest") {
            const hash = `sha256:${sha256HexSync(new TextEncoder().encode(raw))}`;
            for (const schema of ["sys", "catalog"]) c.driver.exec(`UPDATE ${schema}.production_request_receipts SET response_sha256=? WHERE request_id=?`, [hash, f.requestId]);
            claim.receipt.responseSha256 = hash;
          }
        }
      });
    }
    const receive = vi.fn();
    await expect((f.authority as any).withLegacyOwner(claim, receive)).rejects.toThrow(/legacy|owner|proof/i);
    expect(receive).not.toHaveBeenCalled();
  } finally { f.authority.close(); }
});

it("can preserve proven historical custody even when later legacy state is malformed, without activating that state", async () => {
  const f = await legacyIntakeHistory();
  try {
    const candidate = (await f.authority.legacyOwnerInventory(null)).candidates[0]!;
    const c = productionLifecycleContext(f.authority);
    c.writeAuthority.run(() => c.driver.exec("UPDATE sys.settings SET value_json='{' WHERE key='intake_v1'"));
    const result = await f.authority.withLegacyOwner(candidate, async proof => proof);
    expect(result.activation).toBe("custody_only");
    expect(f.driver.select("SELECT value_json='{' AS unchanged FROM sys.settings WHERE key='intake_v1'")[0]?.unchanged).toBe(1);
  } finally { f.authority.close(); }
});

it("validates raw historical bytes under an anchored route without normalizing or replacing the response", async () => {
  const f = await legacyIntakeHistory(undefined, "raw");
  try {
    const original = JSON.stringify(f.form), candidate = (await f.authority.legacyOwnerInventory(null)).candidates[0]!;
    await f.authority.withLegacyOwner(candidate, async (_proof, bytes) => { expect(new TextDecoder().decode(bytes) === original).toBe(true); });
    expect(f.driver.select("SELECT response_json=? AS unchanged FROM sys.production_request_receipts WHERE request_id=?", [original, f.requestId])[0]?.unchanged).toBe(1);
  } finally { f.authority.close(); }
});

it.each(["legacy_fork", "legacy_restore"])("a %s image with copied semantic IDs/private state never acquires original catalog ownership", async kind => {
  const f = await legacyIntakeHistory(); let replica: ProductionStoreAuthority | null = null;
  try {
    const candidate = (await f.authority.legacyOwnerInventory(null)).candidates[0]!;
    // A historical raw image, not a newly allowed private archive export. The
    // actual snapshot API deliberately does not copy original authority tables.
    const copy = await f.driver.snapshot(); copy.exec("ATTACH ':memory:' AS catalog");
    replica = ProductionStoreAuthority.adoptLegacy(copy, { inventory: { state: "complete", catalogPresent: false, namespaces: [
      { storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" }] }, storageKey: "default", displayName: kind, shellId: "blank",
      appInstanceId: `app_${"z".repeat(26)}`, generationId: `gen_${"y".repeat(26)}`, namespaceId: `ns_${"x".repeat(26)}`, adoptionOperationId: `op_${"w".repeat(26)}`,
      releaseId: `rel_${"v".repeat(26)}`, nowMs: Date.now(), leaseTtlMs: 60_000 });
    expect((await replica.legacyOwnerInventory(null)).candidates).toHaveLength(0);
    const sink = vi.fn(); await expect(replica.withLegacyOwner(candidate, sink)).rejects.toThrow(/quarantined/); expect(sink).not.toHaveBeenCalled();
    expect(copy.select("SELECT value_json=? AS unchanged FROM sys.settings WHERE key='intake_v1'", [f.original])[0]?.unchanged).toBe(1);
    expect((await replica.intakePresentation()).legacyCustody).toBe("quarantined");
    await expect(replica.collectArchiveSnapshot()).rejects.toThrow(/custody/);
  } finally { replica?.close(); f.authority.close(); }
});
