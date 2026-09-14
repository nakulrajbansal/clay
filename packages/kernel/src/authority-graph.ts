/** Relationships between already captured, bounded, codec-validated rows.
 * No SQL, storage handles, worker commands, parsing, migration, or write authority.
 * Adapters retain physical/authentication checks and call stages in their original
 * order. Archive modes carry the mandatory selected-target revision mirror.
 */
import type { AppCatalogEntryV1, CatalogGenerationEventV1 as Event,
  CatalogRevisionReservationV1 as Reservation, ImmutableAppGenerationV1 as Generation,
  TargetEvidenceV1 as Target, AppLifecycleReceiptV1 as Lifecycle } from "@clay/schema/catalog";
import type { BackupRecordV1 as Backup } from "@clay/schema/backup";
import type { ArchiveAuthorityEvidenceV1 } from "@clay/schema/archive";
type Revision = ArchiveAuthorityEvidenceV1["targetAuthority"]["revisions"][number];
import { ClayError } from "./errors";

type App = Omit<AppCatalogEntryV1, "tombstoned"> & { tombstoned: boolean };
type Root = { authorityIncarnationId: string; catalogGeneration: string; writeEpoch: string; selectedAppInstanceId: string | null };
export type GraphLease = { authorityIncarnationId: string; writeEpoch: string; releaseId: string;
  issuedAtMs: string; expiresAtMs: string; revoked: boolean };
export type AuthorityGraphMode = { kind: "live" | "recovery" }
  | { kind: "archive-v1" | "archive-v2" | "archive-v3"; targetRevisions: ReadonlyMap<string, Revision> };

export function sameGraphTarget(a: Target, b: Target): boolean {
  return a.appInstanceId === b.appInstanceId && a.activeGenerationId === b.activeGenerationId
    && a.lineageEpoch === b.lineageEpoch && a.protectionRevision === b.protectionRevision
    && a.digestSchema === b.digestSchema && a.stateSha256 === b.stateSha256;
}
export function graphAppTarget(app: App): Target {
  return { appInstanceId: app.appInstanceId, activeGenerationId: app.activeGenerationId,
    lineageEpoch: app.currentLineageEpoch, protectionRevision: app.currentProtectionRevision,
    digestSchema: app.digestSchema, stateSha256: app.stateSha256 };
}
function committedTarget(r: Reservation, target: Target): boolean {
  return r.state === "committed" && r.appInstanceId === target.appInstanceId
    && r.publishedActiveGenerationId === target.activeGenerationId
    && r.publishedLineageEpoch === target.lineageEpoch && r.revision === target.protectionRevision
    && r.stateSha256 === target.stateSha256;
}
export class AuthorityGraph {
  private issuance: Map<string, number> | undefined;
  constructor(readonly mode: AuthorityGraphMode, readonly root: Root,
    readonly apps: ReadonlyMap<string, App>, readonly generations: ReadonlyMap<string, Generation>,
    readonly generationOperations: ReadonlyMap<string, string>) {
    switch (mode.kind) {
      case "live": case "recovery": break;
      case "archive-v1": case "archive-v2": case "archive-v3":
        if (!(mode.targetRevisions instanceof Map)) throw new Error("missing archive target mirror");
        break;
      default: throw new Error("unsupported authority graph mode");
    }
  }
  private get archive() { return this.mode.kind !== "live" && this.mode.kind !== "recovery"; }
  private fail(message: string): never {
    // These are the existing public adapters; live callers keep their catch boundary.
    throw this.archive ? new ClayError("E_VALIDATION", `archive authority evidence is invalid: ${message}`)
      : new Error("authoritative catalog relationships failed validation");
  }
  active(app: App): void {
    const g = this.generations.get(app.activeGenerationId)?.target;
    if (!g || g.appInstanceId !== app.appInstanceId || g.lineageEpoch !== app.currentLineageEpoch
        || BigInt(g.protectionRevision) > BigInt(app.currentProtectionRevision)
        || (!this.archive && (g.digestSchema !== app.digestSchema
          || (g.protectionRevision === app.currentProtectionRevision && g.stateSha256 !== app.stateSha256))))
      this.fail("catalog generation history is incomplete or mismatched");
  }
  genesis(app: App): Generation {
    const g = this.generations.get(app.journalGenesisGenerationId);
    if (!g || g.target.appInstanceId !== app.appInstanceId
        || g.target.lineageEpoch !== app.journalGenesisLineageEpoch
        || g.target.protectionRevision !== app.journalGenesisProtectionRevision
        || g.target.digestSchema !== app.digestSchema || g.target.stateSha256 !== app.journalGenesisStateSha256)
      this.fail("catalog generation history is incomplete or mismatched");
    return g;
  }
  knownTarget(target: Target, reservations: readonly Reservation[]): boolean {
    const g = this.generations.get(target.activeGenerationId);
    return (g !== undefined && sameGraphTarget(target, g.target)) || reservations.some(r => committedTarget(r, target));
  }
  reservation(r: Reservation, leases: ReadonlyMap<string, GraphLease>): void {
    const lease = leases.get(r.leaseId), app = this.apps.get(r.appInstanceId);
    const g = this.generations.get(r.activeGenerationId);
    const reservedAt = BigInt(Date.parse(r.reservedAt));
    if (r.authorityIncarnationId !== this.root.authorityIncarnationId || !lease
        || lease.authorityIncarnationId !== r.authorityIncarnationId || lease.writeEpoch !== r.writeEpoch
        || lease.releaseId !== r.releaseId || !app || !g || g.target.appInstanceId !== r.appInstanceId
        || g.target.lineageEpoch !== r.lineageEpoch || reservedAt < BigInt(lease.issuedAtMs)
        || reservedAt >= BigInt(lease.expiresAtMs)
        || BigInt(r.reservedCatalogGeneration) > BigInt(this.root.catalogGeneration)
        || (r.finalizedCatalogGeneration !== null && BigInt(r.finalizedCatalogGeneration) > BigInt(this.root.catalogGeneration)))
      this.fail("catalog reservation authority relationship is invalid");
    if (r.finalizedAt !== null) {
      const finalizer = r.finalizedLeaseId === null ? undefined : leases.get(r.finalizedLeaseId);
      const at = BigInt(Date.parse(r.finalizedAt)), epoch = BigInt(r.writeEpoch), next = BigInt(r.finalizedWriteEpoch!);
      if (!finalizer || finalizer.authorityIncarnationId !== r.authorityIncarnationId
          || finalizer.writeEpoch !== r.finalizedWriteEpoch || finalizer.releaseId !== r.finalizedReleaseId
          || at < reservedAt || at < BigInt(finalizer.issuedAtMs) || at >= BigInt(finalizer.expiresAtMs)
          || next < epoch || (next === epoch && (r.finalizedLeaseId !== r.leaseId || r.finalizedReleaseId !== r.releaseId))
          || (next > epoch && (r.state !== "abandoned" || next !== epoch + 1n || !lease.revoked
            || BigInt(finalizer.issuedAtMs) < BigInt(lease.expiresAtMs) || at !== BigInt(finalizer.issuedAtMs))))
        this.fail("catalog finalization authority relationship is invalid");
    }
  }
  activeReservation(r: Reservation): void {
    if (r.state !== "reserved") return;
    const app = this.apps.get(r.appInstanceId)!;
    if (this.root.selectedAppInstanceId !== app.appInstanceId
        || !sameGraphTarget(graphAppTarget(app), { appInstanceId: r.appInstanceId, activeGenerationId: r.activeGenerationId,
          lineageEpoch: r.lineageEpoch, protectionRevision: r.expectedProtectionRevision,
          digestSchema: app.digestSchema, stateSha256: r.expectedStateSha256 })
        || r.revision !== app.revisionHighWater || r.reservedCatalogGeneration !== this.root.catalogGeneration)
      this.fail("active revision reservation is not current");
  }
  chain(app: App, reservations: readonly Reservation[]): number {
    // Archive adapters validated every app's genesis before entering chain order.
    const anchor = (this.archive ? this.generations.get(app.journalGenesisGenerationId)! : this.genesis(app)).target;
    const journal = reservations.filter(r => r.appInstanceId === app.appInstanceId);
    const base = BigInt(anchor.protectionRevision), count = BigInt(app.revisionHighWater) - base;
    if (count < 0n || BigInt(journal.length) !== count) this.fail("catalog revision history is incomplete");
    let chained = anchor, previous = -1n, activeCount = 0;
    for (let index = 0; index < journal.length; index++) {
      const r = journal[index]!, reserved = BigInt(r.reservedCatalogGeneration);
      const finalized = r.finalizedCatalogGeneration === null ? null : BigInt(r.finalizedCatalogGeneration);
      if (BigInt(r.revision) !== base + BigInt(index + 1) || reserved <= previous
          || (finalized !== null && finalized !== reserved + 1n)
          || r.activeGenerationId !== chained.activeGenerationId || r.lineageEpoch !== chained.lineageEpoch
          || r.expectedProtectionRevision !== chained.protectionRevision || r.expectedStateSha256 !== chained.stateSha256
          || (r.state === "reserved" && index !== journal.length - 1)
          || (this.archive && (reserved > BigInt(this.root.catalogGeneration)
            || (finalized !== null && finalized > BigInt(this.root.catalogGeneration))
            || r.authorityIncarnationId !== this.root.authorityIncarnationId || r.appInstanceId !== chained.appInstanceId)))
        this.fail("catalog revision history is mismatched or reordered");
      previous = finalized ?? reserved;
      if (r.state === "reserved") activeCount++;
      if (r.state === "committed") {
        const g = r.publishedActiveGenerationId === null ? undefined : this.generations.get(r.publishedActiveGenerationId);
        if (!g || r.publishedLineageEpoch === null || r.stateSha256 === null
            || r.publishedActiveGenerationId !== r.activeGenerationId || r.publishedLineageEpoch !== r.lineageEpoch
            || g.target.appInstanceId !== app.appInstanceId || g.target.lineageEpoch !== r.publishedLineageEpoch
            || BigInt(g.target.protectionRevision) > BigInt(r.revision))
          this.fail("committed catalog revision has no matching generation evidence");
        chained = { appInstanceId: app.appInstanceId, activeGenerationId: r.publishedActiveGenerationId,
          lineageEpoch: r.publishedLineageEpoch, protectionRevision: r.revision,
          digestSchema: app.digestSchema, stateSha256: r.stateSha256 };
      }
      if ((this.mode.kind === "archive-v1" || this.mode.kind === "archive-v2" || this.mode.kind === "archive-v3")
          && app.appInstanceId === this.root.selectedAppInstanceId) {
        const mirror = this.mode.targetRevisions.get(r.revision);
        if (!mirror || mirror.operationId !== r.operationId || mirror.expectedProtectionRevision !== r.expectedProtectionRevision
            || mirror.expectedStateSha256 !== r.expectedStateSha256 || mirror.requestSha256 !== r.requestSha256
            || mirror.state !== r.state || mirror.stateSha256 !== r.stateSha256
            || mirror.reservedAt !== r.reservedAt || mirror.finalizedAt !== r.finalizedAt)
          this.fail("target and catalog revision histories disagree");
      }
    }
    if (!sameGraphTarget(chained, graphAppTarget(app))) this.fail("catalog revision history does not reach an app target");
    return activeCount;
  }
  backup(record: Backup, reservations: readonly Reservation[]): void {
    const app = this.apps.get(record.evidence.appInstanceId), g = this.generations.get(record.evidence.activeGenerationId);
    if (!app || !g || g.target.appInstanceId !== app.appInstanceId || !this.knownTarget(record.evidence, reservations)
        || BigInt(record.publicationCatalogGeneration) > BigInt(this.root.catalogGeneration))
      this.fail("catalog backup history is incomplete or inconsistent");
  }
  backupHistory(records: readonly { record: Backup; operationId: string | null }[], reservations: readonly Reservation[],
    events: readonly Event[], occupied: Set<string>): Map<string, Backup> {
    const operations = new Map<string, Backup>(), generations = new Set<string>(), series = new Set<string>(), files = new Set<string>();
    let previous = "";
    for (const { record: b, operationId } of records) {
      if (this.archive && b.backupId <= previous) this.fail("catalog backup records are reordered or duplicated");
      previous = b.backupId;
      this.backup(b, reservations);
      const event = this.archive ? events.find(e => e.eventKind === "backup_published" && e.catalogGeneration === b.publicationCatalogGeneration) : undefined;
      const seriesGeneration = `${b.authentication.seriesId}:${b.authentication.generation}`;
      if (operationId === null || operations.has(operationId) || generations.has(b.generationId)
          || series.has(seriesGeneration) || files.has(b.fileName)
          || (this.archive ? (!event || event.operationId !== operationId || event.appInstanceId !== b.evidence.appInstanceId || event.at !== b.validatedAt)
            : occupied.has(b.publicationCatalogGeneration)))
        this.fail("catalog backup history is incomplete or inconsistent");
      operations.set(operationId, b); generations.add(b.generationId); series.add(seriesGeneration); files.add(b.fileName);
      if (!this.archive) occupied.add(b.publicationCatalogGeneration);
    }
    return operations;
  }
  eventHistory(events: readonly Event[], reservations: readonly Reservation[], leases: ReadonlyMap<string, GraphLease>,
    backups: ReadonlyMap<string, Backup>): Map<string, Event> {
    if (!this.archive && BigInt(events.length) !== BigInt(this.root.catalogGeneration)) this.fail("catalog generation event high-water is inconsistent");
    const byGeneration = new Map<string, Event>();
    this.issuance = new Map();
    let previous = 0n;
    for (let index = 0; index < events.length; index++) {
      const e = events[index]!, epoch = BigInt(e.writeEpoch);
      if (BigInt(e.catalogGeneration) !== BigInt(index + 1) || epoch < previous || epoch > BigInt(this.root.writeEpoch)
          || (this.archive && BigInt(e.catalogGeneration) > BigInt(this.root.catalogGeneration)))
        this.fail("catalog event history is reordered, duplicated, or incomplete");
      previous = epoch; byGeneration.set(e.catalogGeneration, e);
      if (e.eventKind === "lease_issued" || e.eventKind === "recovery_takeover") {
        const key = `${e.writeEpoch}\u0000${e.at}`;
        this.issuance.set(key, (this.issuance.get(key) ?? 0) + 1);
      }
      if (!this.archive && e.eventKind === "app_seed") {
        if (!this.seed(e, this.apps.get(e.appInstanceId!))) this.fail("catalog app seed event is invalid");
      } else if (!this.archive && e.eventKind === "lease_issued") {
        const matches = [...leases.values()].filter(lease => lease.writeEpoch === e.writeEpoch
          && new Date(Number(lease.issuedAtMs)).toISOString() === e.at);
        if (matches.length !== 1) this.fail("catalog lease event is invalid");
      } else this.event(e, reservations, backups);
    }
    return byGeneration;
  }
  leaseIssuance(lease: GraphLease): void {
    const issuedAt = new Date(Number(lease.issuedAtMs)).toISOString();
    if (this.issuance?.get(`${lease.writeEpoch}\u0000${issuedAt}`) !== 1)
      this.fail("catalog lease issuance evidence is missing or ambiguous");
  }
  event(event: Event, reservations: readonly Reservation[], backups: ReadonlyMap<string, Backup>): void {
    const r = event.operationId === null ? undefined : reservations.find(r => r.operationId === event.operationId);
    if (event.eventKind === "app_selected") {
      if (event.target === null || !this.knownTarget(event.target, reservations)) this.fail("catalog app selection event is invalid");
    } else if (event.eventKind === "app_metadata") {
      if (!this.apps.has(event.appInstanceId!)) this.fail("catalog metadata event references an unknown app");
    } else if (event.eventKind === "backup_published") {
      const backup = event.operationId === null ? undefined : backups.get(event.operationId);
      if (!backup || backup.publicationCatalogGeneration !== event.catalogGeneration
          || backup.evidence.appInstanceId !== event.appInstanceId || backup.validatedAt !== event.at)
        this.fail("catalog backup publication event is invalid");
    } else if (event.eventKind !== "app_seed" && event.eventKind !== "lease_issued") {
      if (!r || r.appInstanceId !== event.appInstanceId) this.fail("catalog revision event is orphaned");
      if (event.eventKind === "revision_reserved") {
        if (r.reservedCatalogGeneration !== event.catalogGeneration || r.writeEpoch !== event.writeEpoch || r.reservedAt !== event.at)
          this.fail("catalog reservation event is invalid");
      } else {
        const epoch = BigInt(r.writeEpoch), finalized = BigInt(r.finalizedWriteEpoch!);
        const takeover = event.eventKind === "recovery_takeover";
        if (r.state !== (event.eventKind === "revision_committed" ? "committed" : "abandoned")
            || r.finalizedCatalogGeneration !== event.catalogGeneration || r.finalizedWriteEpoch !== event.writeEpoch
            || r.finalizedAt !== event.at || (takeover ? finalized !== epoch + 1n : finalized !== epoch))
          this.fail("catalog finalization event is invalid");
      }
    }
  }
  reservationEvents(r: Reservation, events: ReadonlyMap<string, Event>): void {
    const reserved = events.get(r.reservedCatalogGeneration);
    if (!reserved || reserved.eventKind !== "revision_reserved" || reserved.operationId !== r.operationId)
      this.fail("catalog reservation event is missing");
    if (r.finalizedCatalogGeneration !== null) {
      const finalized = events.get(r.finalizedCatalogGeneration);
      if (!finalized || finalized.operationId !== r.operationId
          || !["revision_committed", "revision_abandoned", "recovery_takeover"].includes(finalized.eventKind))
        this.fail("catalog finalization event is missing");
    }
  }
  metadata(app: App, events: readonly Event[]): void {
    const latest = [...events].reverse().find(e => e.appInstanceId === app.appInstanceId && e.displayName !== null);
    if (!latest || latest.displayName !== app.displayName || latest.shellId !== app.shellId)
      this.fail("catalog app metadata does not match its latest event");
  }
  selectedApp(events: readonly Event[]): void {
    const latest = events.filter(e => e.eventKind === "app_seed" || e.eventKind === "app_selected").at(-1);
    if ((!latest && this.archive) || (latest?.appInstanceId ?? null) !== this.root.selectedAppInstanceId)
      this.fail("catalog current selection does not match its event history");
  }
  seed(event: Event, app: App | undefined): boolean {
    const g = app && this.generations.get(app.journalGenesisGenerationId);
    return g !== undefined && event.operationId === this.generationOperations.get(g.generationId)
      && event.at === g.sealedAt && event.target !== null && sameGraphTarget(event.target, g.target);
  }
}
export function graphLifecycleEvent(receipt: Lifecycle, event: Event | undefined): boolean {
    const initial = receipt.schema === 2 ? receipt.initialPublication : undefined;
    const kind = receipt.kind === "rename" || receipt.kind === "restore_aborted" ? "app_metadata"
      : receipt.kind === "create" || receipt.kind === "fork" || receipt.kind === "restore" ? "app_seed" : "app_selected";
    return event !== undefined && event.eventKind === kind && event.operationId === receipt.operationId
      && event.appInstanceId === receipt.resultingSelectedAppInstanceId && (initial !== undefined || event.at === receipt.completedAt);
}
export function graphLifecycleStorage(receipt: Lifecycle, namespaceId: string, generation: Generation | undefined): boolean {
  return generation !== undefined && generation.namespaceId === namespaceId
    && generation.target.appInstanceId === receipt.resultingSelectedAppInstanceId;
}

/** Closed identity accounting shared by both adapters. The physical/string
 * codecs (including kind/prefix checks) run before constructing this ledger. */
export class AuthorityReferences {
  private readonly referenced = new Set<string>();
  constructor(private readonly mode: AuthorityGraphMode["kind"], private readonly retained: ReadonlyMap<string, string>) {
    if (!["live", "recovery", "archive-v1", "archive-v2", "archive-v3"].includes(mode)) throw new Error("unsupported identity graph mode");
  }
  private fail(message: string): never {
    throw this.mode === "live" || this.mode === "recovery" ? new Error("authoritative catalog relationships failed validation")
      : new ClayError("E_VALIDATION", `archive authority evidence is invalid: ${message}`);
  }
  require(value: string | null, kind: "authority" | "app" | "generation" | "namespace" | "lease" | "operation" | "job"): void {
    if (value === null) {
      if (this.mode === "live" || this.mode === "recovery") this.fail("missing retained identity");
      return;
    }
    if (this.retained.get(value) !== kind) this.fail("catalog retained identity evidence is incomplete");
    this.referenced.add(value);
  }
  finish(): void {
    for (const [value, kind] of this.retained) if (kind !== "job" && !this.referenced.has(value))
      this.fail(`catalog contains an unreferenced retained ${kind} identity`);
  }
}
