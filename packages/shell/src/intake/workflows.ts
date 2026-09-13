import { IntakePublicationJobV1, IntakeRevocationJobV1 } from "@clay/schema/intake-workflow";
import type { IntakeCache } from "./session";

type Jobs = { publication: IntakePublicationJobV1; revocation: IntakeRevocationJobV1 };
type Kind = keyof Jobs;
export type IntakeWorkflowRecord = { schema: 1; key: string; shellOrigin: string; appInstanceId: string; kind: Kind; closed: boolean; job: Jobs[Kind] };
export interface IntakeWorkflows {
  read(key: string): Promise<IntakeWorkflowRecord | null>;
  compareAndSet(before: IntakeWorkflowRecord | null, after: IntakeWorkflowRecord): Promise<void>;
}
export class UnfencedIntakeWorkflowError extends Error {
  constructor() { super("Legacy cache-only intake workflow is unfenced. Original work is quarantined until safe owner adoption is available; nothing was discarded."); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keyFor = (origin: string, app: string, kind: Kind) => JSON.stringify([1, origin, app, kind]);
const formId = (job: Jobs[Kind]) => "formId" in job ? job.formId : job.form.publicForm.formId;
const terminal = (job: Jobs[Kind]) => "formId" in job ? (job.termination ? job.termination.complete : !!job.complete) : job.relayConfirmed;
function parse(input: unknown): IntakeWorkflowRecord {
  try {
    const row = input as IntakeWorkflowRecord;
    if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== "appInstanceId,closed,job,key,kind,schema,shellOrigin"
        || row.schema !== 1 || typeof row.closed !== "boolean" || !["publication", "revocation"].includes(row.kind)
        || new URL(row.shellOrigin).origin !== row.shellOrigin || !/^app_[a-z2-7]{26}$/.test(row.appInstanceId)
        || row.key !== keyFor(row.shellOrigin, row.appInstanceId, row.kind)) throw new Error();
    const job = row.kind === "publication" ? IntakePublicationJobV1.parse(row.job) : IntakeRevocationJobV1.parse(row.job);
    const app = "formId" in job ? job.source.appInstanceId : job.form.ownerSource.appInstanceId;
    if (app !== row.appInstanceId || ("formId" in job && job.configuration.shellOrigin !== row.shellOrigin)
        || (row.closed && !terminal(job)) || new TextEncoder().encode(JSON.stringify(row)).byteLength > 2_000_000) throw new Error();
    return { schema: 1, key: row.key, shellOrigin: row.shellOrigin, appInstanceId: row.appInstanceId, kind: row.kind, closed: row.closed, job };
  } catch { throw new Error("Intake workflow custody is invalid; originals were kept"); }
}
function transition(before: IntakeWorkflowRecord | null, after: IntakeWorkflowRecord): void {
  if (!before) { if (after.closed) throw new Error("Original intake workflow required"); return; }
  if (before.key !== after.key) throw new Error("Intake workflow identity changed");
  if (same(before, after)) return;
  if (before.closed) {
    if (after.closed || formId(before.job) === formId(after.job)) throw new Error("Completed intake workflow is immutable");
    return;
  }
  const a = before.job, b = after.job;
  if (after.closed) { if (!same(a, b) || !terminal(b)) throw new Error("Intake workflow is not complete or terminal"); return; }
  if ("formId" in a && "formId" in b) {
    if (!same([a.formId, a.source, a.configuration, a.proposal], [b.formId, b.source, b.configuration, b.proposal])
        || (a.save && !same(a.save, b.save)) || (a.publish && !same(a.publish, b.publish)) || (a.complete && !same(a.complete, b.complete))
        || (a.relayInvoked && !b.relayInvoked) || (a.relayConfirmed && !b.relayConfirmed)
        || (a.termination && (!b.termination || a.termination.requestedAt !== b.termination.requestedAt
          || (a.termination.complete && !b.termination.complete) || !same({ ...a, termination: null }, { ...b, termination: null }))))
      throw new Error("Original intake workflow payload is immutable");
  } else if (!("formId" in a) && !("formId" in b)) {
    if (!same([a.form, a.intent], [b.form, b.intent]) || (a.relayConfirmed && !b.relayConfirmed)) throw new Error("Original revocation is immutable");
  } else throw new Error("Intake workflow identity changed");
}

/** Public-only shell recovery ledger, separate from immutable private custody
 * and app DB. CAS prevents a delayed tab from resurrecting a closed invocation.
 * A terminal slot can be reused, but private custody and worker receipts remain. */
export class IndexedDbIntakeWorkflows implements IntakeWorkflows {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error("Intake workflow custody unavailable")); return; }
      const request = this.factory.open("clay-intake-workflows-v1", 1); let settled = false;
      request.onupgradeneeded = () => { if (settled) request.transaction?.abort(); else request.result.createObjectStore("workflows", { keyPath: "key" }); };
      request.onerror = request.onblocked = () => { if (!settled) { settled = true; reject(new Error("Intake workflow custody unavailable")); } };
      request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }
  async read(key: string): Promise<IntakeWorkflowRecord | null> {
    const db = await this.open();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction("workflows", "readonly"); const request = tx.objectStore("workflows").get(key); let result: unknown;
      request.onsuccess = () => { result = request.result; };
      tx.onerror = tx.onabort = () => reject(new Error("Intake workflow read failed"));
      tx.oncomplete = () => { try { const row = result === undefined ? null : parse(result); if (row && row.key !== key) throw new Error(); resolve(row); } catch { reject(new Error("Intake workflow readback is invalid")); } };
    }); } finally { db.close(); }
  }
  async compareAndSet(beforeInput: IntakeWorkflowRecord | null, afterInput: IntakeWorkflowRecord): Promise<void> {
    const before = beforeInput ? parse(beforeInput) : null, after = parse(afterInput); transition(before, after);
    const db = await this.open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("workflows", "readwrite"); const store = tx.objectStore("workflows"); const get = store.get(after.key);
      get.onsuccess = () => { try {
        const current = get.result === undefined ? null : parse(get.result);
        if (same(current, after)) return;
        if (!same(current, before)) { tx.abort(); return; }
        if (current) store.put(after);
        else { const count = store.count(); count.onsuccess = () => { if (count.result >= 1000) tx.abort(); else store.add(after); }; }
      } catch { tx.abort(); } };
      tx.onerror = tx.onabort = () => reject(new Error("Intake workflow commit conflicted or failed; original work was kept"));
      tx.oncomplete = () => resolve();
    }); } finally { db.close(); }
  }
}

export class IntakeWorkflowSlot<K extends Kind> {
  private record: IntakeWorkflowRecord | null = null;
  private loaded = false;
  readonly cacheKey: string;
  readonly key: string;
  constructor(readonly store: IntakeWorkflows, readonly cache: IntakeCache, readonly origin: string, readonly app: string, readonly kind: K) {
    this.key = keyFor(origin, app, kind); this.cacheKey = `clay_intake_${kind}_v1:${app}`;
  }
  async recover(): Promise<Jobs[K] | null> {
    const found = await this.store.read(this.key); const raw = this.cache.getItem(this.cacheKey);
    const cached = raw === null ? null : parse({ schema: 1, key: this.key, shellOrigin: this.origin, appInstanceId: this.app, kind: this.kind, closed: false, job: JSON.parse(raw) }).job;
    this.record = found; this.loaded = true;
    if (found && cached && formId(cached) === formId(found.job)) {
      // A cache may lag a committed checkpoint, never introduce a different
      // original request or silently discard a workflow newer than the ledger.
      transition({ ...found, closed: false, job: cached }, { ...found, closed: false });
    }
    if (found && !found.closed) {
      if (cached && formId(cached) !== formId(found.job)) throw new Error("Original intake workflow identity conflicted; both records were kept");
      this.cache.setItem(this.cacheKey, JSON.stringify(found.job)); return found.job as Jobs[K];
    }
    if (found?.closed && cached && formId(cached) === formId(found.job)) { this.cache.removeItem(this.cacheKey); return null; }
    // An older tab may still mint an invocation outside this ledger. Merely
    // copying its cache cannot prove exclusion of that unknown future request.
    // Original bytes stay untouched for the narrow legacy adoption protocol.
    if (cached) throw new UnfencedIntakeWorkflowError();
    return null;
  }
  async persist(job: Jobs[K]): Promise<Jobs[K]> {
    if (!this.loaded) throw new Error("Recover original intake workflow before another invocation");
    const after = parse({ schema: 1, key: this.key, shellOrigin: this.origin, appInstanceId: this.app, kind: this.kind, closed: false, job });
    await this.store.compareAndSet(this.record, after);
    const read = await this.store.read(this.key);
    if (!same(read, after)) throw new Error("Intake workflow changed during commit readback");
    this.record = read; this.cache.setItem(this.cacheKey, JSON.stringify(after.job));
    return after.job as Jobs[K];
  }
  async finish(): Promise<void> {
    if (!this.record || !terminal(this.record.job)) throw new Error("Intake workflow is not complete or terminal");
    const after = { ...this.record, closed: true };
    await this.store.compareAndSet(this.record, after);
    if (!same(await this.store.read(this.key), after)) throw new Error("Intake workflow changed during close readback");
    this.record = after;
    const raw = this.cache.getItem(this.cacheKey);
    if (raw !== null && formId(JSON.parse(raw) as Jobs[K]) !== formId(after.job)) throw new Error("Intake workflow cache changed; original close was retained");
    this.cache.removeItem(this.cacheKey);
  }
}

export async function recoverIntakeWorkflows(cache: IntakeCache, origin: string, app: string,
  store: IntakeWorkflows = new IndexedDbIntakeWorkflows()): Promise<boolean> {
  let pending = false;
  for (const kind of ["publication", "revocation"] as const) if (await new IntakeWorkflowSlot(store, cache, origin, app, kind).recover()) pending = true;
  return pending;
}
