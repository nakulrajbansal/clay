import {
  inspectAuthenticatedArchiveV5Header,
  type AuthenticatedArchiveHeaderV1,
} from "@clay/kernel/backup";
import {
  parseAuthenticatedFormat5RestoreGrant,
  type AuthenticatedFormat5RestoreGrant,
} from "@clay/kernel/recovery";
import type {
  ProductionAuthenticatedRestoreInspection,
  ProductionBootInfo,
} from "@clay/kernel/worker-authority";
import type { BackupTrustRuntime } from "./backup-trust-runtime";

const ID = /^(restoreval|app|gen|ns|op)_[a-z2-7]{26}$/;
const MAX_PENDING_RESTORES = 4;

type RestoreIdPrefix = "restoreval" | "app" | "gen" | "ns" | "op";

export interface RestoreAsNewWorkerAuthority<TResult = unknown> {
  bootInfo(): ProductionBootInfo;
  inspectAuthenticatedRestoreArchive(
    bytes: Uint8Array,
    backupTrustKey: Uint8Array,
  ): Promise<ProductionAuthenticatedRestoreInspection>;
  restoreAuthenticatedArchiveAsNew(
    bytes: Uint8Array,
    backupTrustKey: Uint8Array,
    identity: Readonly<{
      schema: 1;
      appInstanceId: string;
      generationId: string;
      namespaceId: string;
      operationId: string;
      restoredAt: string;
    }>,
    sourceProvenanceId: string,
  ): Promise<TResult>;
}

export type RestoreAsNewWorkerOptions = Readonly<{
  createId?: (prefix: RestoreIdPrefix) => string;
  now?: () => string;
}>;

type PendingRestore = {
  grant: AuthenticatedFormat5RestoreGrant;
  envelope: Uint8Array;
  identity: {
    schema: 1;
    appInstanceId: string;
    generationId: string;
    namespaceId: string;
    operationId: string;
    restoredAt: string;
  };
};

type InspectedRestore = {
  header: AuthenticatedArchiveHeaderV1;
  inspection: ProductionAuthenticatedRestoreInspection;
  freshness: "current" | "unknown";
};

function invalid(message: string): Error {
  return new Error(message);
}

function randomId(prefix: RestoreIdPrefix): string {
  const source = globalThis.crypto;
  if (!source?.getRandomValues)
    throw invalid("trusted restore identity source is unavailable");
  const bytes = source.getRandomValues(new Uint8Array(17));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31]!;
      value &= (1 << bits) - 1;
    }
    if (encoded.length === 26) break;
  }
  return `${prefix}_${encoded}`;
}

function hex(bytes: Uint8Array): string {
  let output = "";
  for (const value of bytes) output += value.toString(16).padStart(2, "0");
  return output;
}

function sameTarget(
  left: ProductionAuthenticatedRestoreInspection["target"],
  right: ProductionAuthenticatedRestoreInspection["target"],
): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function sameAuthentication(
  inspection: ProductionAuthenticatedRestoreInspection,
  header: AuthenticatedArchiveHeaderV1,
): boolean {
  return inspection.authentication.authenticationVersion === header.authenticationVersion
    && inspection.authentication.keyId === hex(header.keyId)
    && inspection.authentication.seriesId === hex(header.seriesId)
    && inspection.authentication.generation === header.generation.toString();
}

export class RestoreAsNewWorkerCoordinator<TResult = unknown> {
  readonly #authority: RestoreAsNewWorkerAuthority<TResult>;
  readonly #trust: BackupTrustRuntime;
  readonly #createId: (prefix: RestoreIdPrefix) => string;
  readonly #now: () => string;
  readonly #pending = new Map<string, PendingRestore>();

  constructor(
    authority: RestoreAsNewWorkerAuthority<TResult>,
    trust: BackupTrustRuntime,
    options: RestoreAsNewWorkerOptions = {},
  ) {
    this.#authority = authority;
    this.#trust = trust;
    this.#createId = options.createId ?? randomId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #id(prefix: RestoreIdPrefix): string {
    const value = this.#createId(prefix);
    if (!ID.test(value) || !value.startsWith(`${prefix}_`))
      throw invalid("trusted restore identity source failed");
    return value;
  }

  async #inspect(
    envelope: Uint8Array,
  ): Promise<InspectedRestore> {
    const header = inspectAuthenticatedArchiveV5Header(envelope);
    const seriesId = hex(header.seriesId);
    const key = await this.#trust.keyForSeries(seriesId);
    if (!key) {
      header.keyId.fill(0);
      header.seriesId.fill(0);
      throw invalid("Recovery Kit for this authenticated archive is not enrolled");
    }
    try {
      const inspection = await this.#authority.inspectAuthenticatedRestoreArchive(envelope, key);
      if (!sameAuthentication(inspection, header))
        throw invalid("authenticated restore inspection changed key selection evidence");
      const freshness = await this.#trust.assess(header, envelope);
      if (freshness !== "current" && freshness !== "unknown")
        throw invalid(`authenticated archive freshness is ${freshness}`);
      return { header, inspection, freshness };
    } catch (error) {
      header.keyId.fill(0);
      header.seriesId.fill(0);
      throw error;
    } finally {
      key.fill(0);
    }
  }

  async validate(
    envelopeInput: Uint8Array,
    ownership: "retained" | "transferred" = "retained",
  ): Promise<AuthenticatedFormat5RestoreGrant> {
    if (!(envelopeInput instanceof Uint8Array)
        || Object.getPrototypeOf(envelopeInput) !== Uint8Array.prototype
        || envelopeInput.byteLength === 0)
      throw invalid("authenticated restore archive bytes are malformed");
    const envelope = ownership === "transferred" ? envelopeInput : envelopeInput.slice();
    let inspected: InspectedRestore;
    try {
      inspected = await this.#inspect(envelope);
    } catch (error) {
      envelope.fill(0);
      throw error;
    }
    const { header, inspection, freshness } = inspected;
    try {
      const boot = this.#authority.bootInfo();
      const validationId = this.#id("restoreval");
      let destinationAppInstanceId = this.#id("app");
      for (let attempt = 0;
        attempt < 8 && (destinationAppInstanceId === boot.selectedAppInstanceId
          || destinationAppInstanceId === inspection.target.appInstanceId);
        attempt++) destinationAppInstanceId = this.#id("app");
      if (destinationAppInstanceId === boot.selectedAppInstanceId
          || destinationAppInstanceId === inspection.target.appInstanceId)
        throw invalid("trusted restore destination identity is not fresh");
      const validatedAt = this.#now();
      if (new Date(validatedAt).toISOString() !== validatedAt)
        throw invalid("trusted restore clock is invalid");
      const candidate = {
        schema: 1 as const,
        kind: "authenticated_format5_restore_as_new" as const,
        validationId,
        archiveFormat: 5 as const,
        cryptographicallyAuthenticated: true as const,
        authentication: inspection.authentication,
        freshness,
        archiveSha256: inspection.archiveSha256,
        archiveTarget: inspection.target,
        preservedAppInstanceId: boot.selectedAppInstanceId,
        destinationAppInstanceId,
        installMode: "new_app_only" as const,
        validatedAt,
      };
      const grant = parseAuthenticatedFormat5RestoreGrant(candidate);
      if (!grant) throw invalid("trusted restore grant construction failed");
      const pending: PendingRestore = {
        grant,
        envelope,
        identity: {
          schema: 1,
          appInstanceId: destinationAppInstanceId,
          generationId: this.#id("gen"),
          namespaceId: this.#id("ns"),
          operationId: this.#id("op"),
          restoredAt: validatedAt,
        },
      };
      while (this.#pending.size >= MAX_PENDING_RESTORES) {
        const oldest = this.#pending.keys().next().value as string | undefined;
        if (!oldest) break;
        const removed = this.#pending.get(oldest);
        removed?.envelope.fill(0);
        this.#pending.delete(oldest);
      }
      this.#pending.set(validationId, pending);
      return structuredClone(grant);
    } catch (error) {
      envelope.fill(0);
      throw error;
    } finally {
      header.keyId.fill(0);
      header.seriesId.fill(0);
    }
  }

  async restore(grantInput: unknown): Promise<TResult> {
    const grant = parseAuthenticatedFormat5RestoreGrant(grantInput);
    if (!grant) throw invalid("authenticated restore grant is malformed");
    const pending = this.#pending.get(grant.validationId);
    if (!pending || JSON.stringify(pending.grant) !== JSON.stringify(grant))
      throw invalid("authenticated restore grant is expired or was not validated by this worker");
    const boot = this.#authority.bootInfo();
    if (boot.selectedAppInstanceId !== grant.preservedAppInstanceId)
      throw invalid("preserved app selection changed after restore validation");

    const inspected = await this.#inspect(pending.envelope);
    const { header, inspection, freshness } = inspected;
    try {
      if (inspection.archiveSha256 !== grant.archiveSha256
          || !sameTarget(inspection.target, grant.archiveTarget)
          || JSON.stringify(inspection.authentication) !== JSON.stringify(grant.authentication)
          || freshness !== grant.freshness)
        throw invalid("authenticated restore evidence changed after validation");
      const key = await this.#trust.keyForSeries(grant.authentication.seriesId);
      if (!key) throw invalid("Recovery Kit trust disappeared before restore");
      try {
        const restoredAt = this.#now();
        if (new Date(restoredAt).toISOString() !== restoredAt)
          throw invalid("trusted restore clock is invalid");
        const result = await this.#authority.restoreAuthenticatedArchiveAsNew(
          pending.envelope, key, Object.freeze({ ...pending.identity, restoredAt }), grant.validationId,
        );
        pending.envelope.fill(0);
        this.#pending.delete(grant.validationId);
        return result;
      } finally {
        key.fill(0);
      }
    } finally {
      header.keyId.fill(0);
      header.seriesId.fill(0);
    }
  }
}
