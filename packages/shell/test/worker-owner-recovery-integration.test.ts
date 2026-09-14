import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { ownedBrowserStorage } from "../../kernel/test/helpers/owned-browser-storage";
import { IntakeSession } from "../src/intake/session";
import { IntakePublication } from "../src/intake/publication";
import { IndexedDbIntakeWorkflows } from "../src/intake/workflows";
import { IndexedDbIntakeOwnerVault } from "../src/intake/owner-custody.browser";
import { OwnedFactory } from "./helpers/owned-idb";
import { ownedRelayApp } from "../../backend/test/helpers/owned-relay-app";
import { MemoryIntakeRelayStore } from "../../backend/src/intake-relay";
import { IntakeCommandPayloadV1 } from "@clay/schema/catalog";
import { LocalIntakeFormV2 } from "@clay/schema/intake";

it.each(["relay", "ledger", "cache", "close_readback", "configuration"])("closes only a catalog-proven deleted original publication after %s loss, retaining custody/requests and excluding delayed worker/HTTP work after reload", async fault => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  const files = ownedBrowserStorage(), rows = new Map<string, string>();
  const cache = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const ledger = new OwnedFactory(), custody = new OwnedFactory();
  const workflows = new IndexedDbIntakeWorkflows(ledger as unknown as IDBFactory), vault = new IndexedDbIntakeOwnerVault(custody as unknown as IDBFactory);
  const configuration = { shellOrigin: "https://owner.example", publicBaseUrl: "https://owner.example", relayBaseUrl: "https://relay.example/" };
  const backend = ownedRelayApp({ intakeRelay: new MemoryIntakeRelayStore() });
  let heldHttp: { url: string; init?: RequestInit } | null = null, loseTerminal = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/intake/forms")) { heldHttp = { url: String(url), init }; throw new Error("Owned delayed publication"); }
    const response = await backend.request(String(url), init);
    if (loseTerminal) { loseTerminal = false; throw new Error("Owned terminal response loss"); }
    return response;
  };
  const sent: Array<{ id: number; op: string; payload?: unknown }> = [];
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (data: unknown) => queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent)) };
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (data: { id: number; op: string }) => {
    sent.push(structuredClone(data)); queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data) } as MessageEvent));
  }, terminate: () => {} };
  vi.stubGlobal("self", scope); let client = new WorkerClient(transport as unknown as Worker);
  const reopenPublication = (app: string) => new IntakePublication(new IntakeSession(cache, client, app), vault, configuration, fetcher, workflows);
  try {
    const module = "../src/worker/db-worker.ts"; await import(`${module}?original-owner-${fault}`);
    const boot = await client.boot({ requestedAppId: null, appCache: [] });
    await client.seed("tracker", client.createMutationContext());
    const session = new IntakeSession(cache, client, boot.selectedAppInstanceId), read = await session.read();
    const table = read.trace.tables.find(row => row.name === "items" && row.state === "visible")!;
    const title = read.trace.fields.find(row => row.tableName === "items" && row.fieldName === "name" && row.state === "visible")!;
    let publication = new IntakePublication(session, vault, configuration, fetcher, workflows);
    await publication.recover(); await publication.begin({ title: "Original retained form", description: "", expiresAt: "2026-09-20T12:00:00.000Z",
      target: { tableId: table.tableId, expectedSchemaVersion: read.trace.atVersion },
      fields: [{ fieldId: title.fieldId, label: "Name", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] });
    await expect(publication.resume()).rejects.toThrow(/uncertain/);
    const original = publication.pending()!, form = LocalIntakeFormV2.parse(IntakeCommandPayloadV1.parse(original.save!.payload).command.payload.form);
    const claim = { schema: 1 as const, requestId: original.save!.requestId, source: original.source, form };
    const beforeRejectedClaim = sent.length;
    await expect(client.intakeOwnerWitness({ ...claim, form: { ...form, ownerToken: "synthetic-not-for-transport" } } as unknown as typeof claim)).rejects.toThrow(/closed public/);
    expect(sent.length).toBe(beforeRejectedClaim);
    const live = await client.intakeOwnerWitness(claim);
    expect(typeof publication.closeDeletedOriginal).toBe("function");
    await expect(publication.closeDeletedOriginal(live)).rejects.toThrow(/deleted|retirement/);
    const fork = await client.forkApp(client.createMutationContext());
    expect((await client.intakeOwnerWitness(claim)).status).toBe("history_only");
    await expect(publication.closeDeletedOriginal(await client.intakeOwnerWitness(claim))).rejects.toThrow(/deleted|retirement/);
    expect((await client.intakePresentation()).forms[0]?.ownerSource).toEqual(form.ownerSource);
    await client.switchApp(boot.selectedAppInstanceId, client.createMutationContext());
    await client.deleteApp(boot.selectedAppInstanceId, client.createMutationContext());
    const reviewed = await client.intakeOwnerWitness(claim); expect(reviewed.status).toBe("deleted");
    expect((await client.boot({ requestedAppId: null, appCache: [] })).selectedAppInstanceId).toBe(fork.selectedAppInstanceId);
    const privateBefore = JSON.stringify([...custody.rows]);
    if (fault === "relay") loseTerminal = true;
    else if (fault === "ledger") ledger.failCommit = true;
    else if (fault === "cache") {
      const set = cache.setItem; let lost = false;
      cache.setItem = (key, value) => { if (!lost && JSON.parse(value).termination?.deletedOwner) { lost = true; throw new Error("Owned presentation loss"); } set(key, value); };
    } else if (fault === "close_readback") {
      const readWorkflow = workflows.read.bind(workflows); let lost = false;
      vi.spyOn(workflows, "read").mockImplementation(async key => {
        const row = await readWorkflow(key); if (row?.closed && !lost) { lost = true; throw new Error("Owned close readback loss"); } return row;
      });
    } else publication = new IntakePublication(new IntakeSession(cache, client, boot.selectedAppInstanceId), vault,
      { ...configuration, relayBaseUrl: "https://changed.example/" }, fetcher, workflows);
    await expect(publication.closeDeletedOriginal(reviewed)).rejects.toThrow();
    expect(JSON.stringify([...custody.rows]) === privateBefore).toBe(true);
    rows.clear(); await client.shutdown();
    await import(`${module}?original-owner-reload-${fault}`);
    client = new WorkerClient(transport as unknown as Worker); await client.boot({ requestedAppId: null, appCache: [] });
    publication = reopenPublication(boot.selectedAppInstanceId);
    await publication.closeDeletedOriginal(reviewed);
    expect(publication.pending()).toBeNull();
    const record = [...ledger.rows.values()][0] as any;
    expect(record.closed).toBe(true); expect(record.job.save).toEqual(original.save); expect(record.job.publish).toEqual(original.publish);
    expect(record.job.termination.deletedOwner.retirement).toEqual(reviewed.retirement);
    expect(record.job.termination.relayTerminal.terminal).toBe(true);
    expect(JSON.stringify([...custody.rows]) === privateBefore).toBe(true);
    const late = original.publish!;
    await expect(client.intakeCommand(IntakeCommandPayloadV1.parse(late.payload), { requestId: late.requestId })).rejects.toThrow(/source|target/);
    expect(heldHttp !== null).toBe(true);
    // The relay's permanent publication tombstone returns conflict for a late
    // registration (not a successful create, nor a not-found snapshot).
    expect((await backend.request(heldHttp!.url, heldHttp!.init)).status).toBe(409);
    expect(sent.some(row => /ownerPrivateKey|ownerToken|submitToken|response_json/.test(JSON.stringify(row)))).toBe(false);
  } finally { await client.shutdown().catch(() => {}); files.close(); vi.unstubAllGlobals(); vi.useRealTimers(); }
}, 60_000);
