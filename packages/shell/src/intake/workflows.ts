import { IntakePublicationJobV1, IntakeRevocationJobV1 } from "@clay/schema/intake-workflow";
import type { IntakeCache } from "./session";

type Jobs = { publication: IntakePublicationJobV1; revocation: IntakeRevocationJobV1 };
type Kind = keyof Jobs;
type PriorWorkflow = { job: Jobs[Kind]; legacyOriginal?: Jobs[Kind] };
export type IntakeWorkflowRecord = { schema: 1; key: string; shellOrigin: string; appInstanceId: string; kind: Kind; closed: boolean; job: Jobs[Kind];
  legacyOriginal?: Jobs[Kind]; history?: PriorWorkflow[] };
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
    if (!row || typeof row !== "object" || Object.keys(row).filter(key => !["legacyOriginal", "history"].includes(key)).sort().join() !== "appInstanceId,closed,job,key,kind,schema,shellOrigin"
        || row.schema !== 1 || typeof row.closed !== "boolean" || !["publication", "revocation"].includes(row.kind)
        || new URL(row.shellOrigin).origin !== row.shellOrigin || !/^app_[a-z2-7]{26}$/.test(row.appInstanceId)
        || row.key !== keyFor(row.shellOrigin, row.appInstanceId, row.kind)) throw new Error();
    const job = row.kind === "publication" ? IntakePublicationJobV1.parse(row.job) : IntakeRevocationJobV1.parse(row.job);
    const app = "formId" in job ? job.source.appInstanceId : job.form.ownerSource.appInstanceId;
    if (app !== row.appInstanceId || ("formId" in job && job.configuration.shellOrigin !== row.shellOrigin)
        || (row.closed && !terminal(job)) || new TextEncoder().encode(JSON.stringify(row)).byteLength > 2_000_000) throw new Error();
    const legacyOriginal = row.legacyOriginal === undefined ? undefined : row.kind === "publication"
      ? IntakePublicationJobV1.parse(row.legacyOriginal) : IntakeRevocationJobV1.parse(row.legacyOriginal);
    if (legacyOriginal) {
      if ("formId" in legacyOriginal && "formId" in job) {
        if (!job.termination || !same({ ...legacyOriginal, termination: null }, { ...job, termination: null })
            || (job.termination.complete && !job.termination.authorityClosure)) throw new Error();
        // Independent schema validity does not prove that adoption preserved an
        // already-retained original closure. Validate the entire monotonic
        // termination history on physical readback, not only on new CAS writes.
        assertClosureHistory(legacyOriginal, job, false);
      } else if (!("formId" in legacyOriginal) && !("formId" in job)) {
        const original = legacyOriginal.renewals ?? [], current = job.renewals ?? [];
        if (!same([legacyOriginal.form, legacyOriginal.intent], [job.form, job.intent]) || current.length < original.length
            || !same(original, current.slice(0, original.length)) || (row.closed && !job.terminalProof)) throw new Error();
      } else throw new Error();
    }
    if (row.history && (!Array.isArray(row.history) || row.history.length > 100)) throw new Error();
    const history = row.history === undefined ? undefined : row.history.map(prior => {
      if (!prior || Object.keys(prior).some(key => !["job", "legacyOriginal"].includes(key))) throw new Error();
      const parsed = parse({ ...row, history: undefined, job: prior.job, legacyOriginal: prior.legacyOriginal, closed: true });
      return { job: parsed.job, ...(parsed.legacyOriginal ? { legacyOriginal: parsed.legacyOriginal } : {}) };
    });
    if (history && (new Set(history.map(prior => formId(prior.job))).size !== history.length
        || history.some(prior => formId(prior.job) === formId(job)))) throw new Error();
    return { schema: 1, key: row.key, shellOrigin: row.shellOrigin, appInstanceId: row.appInstanceId, kind: row.kind, closed: row.closed, job,
      ...(legacyOriginal ? { legacyOriginal } : {}), ...(history ? { history } : {}) };
  } catch { throw new Error("Intake workflow custody is invalid; originals were kept"); }
}
function assertClosureHistory(a: IntakePublicationJobV1, b: IntakePublicationJobV1, singleAppend: boolean): void {
  if (a.termination && (!b.termination || a.termination.requestedAt !== b.termination.requestedAt
      || (a.termination.complete && !b.termination.complete))) throw new Error("Original closure state is immutable");
  if (a.termination?.authorityClosure && !same(a.termination.authorityClosure, b.termination?.authorityClosure))
    throw new Error("Original authority closure is immutable");
  const prior = a.termination?.renewals ?? [], next = b.termination?.renewals ?? [];
  if (next.length < prior.length || (singleAppend && next.length > prior.length + 1) || !same(prior, next.slice(0, prior.length))
      || ((a.termination?.complete || a.termination?.closureReceipt) && !same(prior, next)))
    throw new Error("Original closure renewal history is immutable");
  for (const proof of ["closureReceipt", "relayTerminal"] as const)
    if (a.termination?.[proof] && !same(a.termination[proof], b.termination?.[proof])) throw new Error("Original closure proof is immutable");
}
function transition(before: IntakeWorkflowRecord | null, after: IntakeWorkflowRecord): void {
  if (!before) { if (after.closed) throw new Error("Original intake workflow required"); return; }
  if (before.key !== after.key) throw new Error("Intake workflow identity changed");
  if (same(before, after)) return;
  if (before.closed) {
    if (after.closed || formId(before.job) === formId(after.job)) throw new Error("Completed intake workflow is immutable");
    if (!same(after.history, [...(before.history ?? []), { job: before.job, ...(before.legacyOriginal ? { legacyOriginal: before.legacyOriginal } : {}) }]))
      throw new Error("Prior intake identities must be retained");
    return;
  }
  if (!same(before.history, after.history) || !same(before.legacyOriginal, after.legacyOriginal)) throw new Error("Original intake history is immutable");
  const a = before.job, b = after.job;
  if (after.closed) { if (!same(a, b) || !terminal(b)) throw new Error("Intake workflow is not complete or terminal"); return; }
  if ("formId" in a && "formId" in b) {
    if (!same([a.formId, a.source, a.configuration, a.proposal], [b.formId, b.source, b.configuration, b.proposal])
        || (a.save && !same(a.save, b.save)) || (a.publish && !same(a.publish, b.publish)) || (a.complete && !same(a.complete, b.complete))
        || (a.relayInvoked && !b.relayInvoked) || (a.relayConfirmed && !b.relayConfirmed)
        || (a.termination && (!b.termination || a.termination.requestedAt !== b.termination.requestedAt
          || (a.termination.complete && !b.termination.complete) || !same({ ...a, termination: null }, { ...b, termination: null }))))
      throw new Error("Original intake workflow payload is immutable");
    assertClosureHistory(a, b, true);
  } else if (!("formId" in a) && !("formId" in b)) {
    if (!same([a.form, a.intent], [b.form, b.intent]) || (a.relayConfirmed && !b.relayConfirmed)) throw new Error("Original revocation is immutable");
    const prior = a.renewals ?? [], next = b.renewals ?? [];
    if (next.length < prior.length || next.length > prior.length + 1 || !same(prior, next.slice(0, prior.length))
        || (a.relayConfirmed && !same(prior, next))) throw new Error("Original renewal history is immutable");
    if (a.terminalProof && !same(a.terminalProof, b.terminalProof)) throw new Error("Original terminal proof is immutable");
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
    const history = this.record?.closed ? [...(this.record.history ?? []), { job: this.record.job,
      ...(this.record.legacyOriginal ? { legacyOriginal: this.record.legacyOriginal } : {}) }] : this.record?.history;
    const after = parse({ schema: 1, key: this.key, shellOrigin: this.origin, appInstanceId: this.app, kind: this.kind, closed: false, job,
      ...(history ? { history } : {}), ...(!this.record?.closed && this.record?.legacyOriginal ? { legacyOriginal: this.record.legacyOriginal } : {}) });
    await this.store.compareAndSet(this.record, after);
    const read = await this.store.read(this.key);
    if (!same(read, after)) throw new Error("Intake workflow changed during commit readback");
    this.record = read; this.cache.setItem(this.cacheKey, JSON.stringify(after.job));
    return after.job as Jobs[K];
  }
  /** Closure-only claim: not a fence against old clients. The worker's permanent
   * form exclusion and the exact relay tombstone are required before finish. */
  async claimLegacyClosure(original: IntakePublicationJobV1): Promise<void> {
    if (this.kind !== "publication") throw new Error("Legacy publication closure required");
    await this.claimLegacy(original, { ...original, termination: original.termination ?? { requestedAt: new Date().toISOString(), complete: false } });
  }
  async claimLegacyRevocation(original: IntakeRevocationJobV1): Promise<void> {
    if (this.kind !== "revocation") throw new Error("Legacy revocation recovery required");
    await this.claimLegacy(original, original);
  }
  private async claimLegacy(original: Jobs[Kind], job: Jobs[Kind]): Promise<void> {
    try { await this.recover(); throw new Error("Original legacy workflow is not available"); }
    catch (error) { if (!(error instanceof UnfencedIntakeWorkflowError)) throw error; }
    const cached = this.cache.getItem(this.cacheKey);
    const parsed = cached === null ? null : this.kind === "publication" ? IntakePublicationJobV1.parse(JSON.parse(cached)) : IntakeRevocationJobV1.parse(JSON.parse(cached));
    if (!same(parsed, original)) throw new Error("Original legacy cache changed");
    const history = this.record?.closed ? [...(this.record.history ?? []), { job: this.record.job,
      ...(this.record.legacyOriginal ? { legacyOriginal: this.record.legacyOriginal } : {}) }] : this.record?.history;
    const after = parse({ schema: 1, key: this.key, shellOrigin: this.origin, appInstanceId: this.app, kind: this.kind, closed: false,
      job, legacyOriginal: original,
      ...(history ? { history } : {}) });
    await this.store.compareAndSet(this.record, after);
    if (!same(await this.store.read(this.key), after)) throw new Error("Legacy closure claim needs readback; original work was kept");
    this.record = after; this.cache.setItem(this.cacheKey, JSON.stringify(after.job));
  }
  requiresAuthorityClosure(): boolean { return !!this.record?.legacyOriginal; }
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
