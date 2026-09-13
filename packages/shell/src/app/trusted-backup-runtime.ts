import { CLAY_ARCHIVE_CONTENT_TYPE, sealAuthenticatedArchiveV5 } from "@clay/kernel/archive-authentication";
import type { ProductionStoreAuthority } from "@clay/kernel/worker-authority";
import { AutomaticBackupWorkerCoordinator, type AutomaticBackupWorkerAuthority } from "../worker/automatic-backup";
import { BackupTrustRuntime } from "../worker/backup-trust-runtime";
import { IndexedDbBackupTrustRecordStore } from "./backup-trust-store.browser";
import { serveArchiveVerification } from "./archive-verification";

type Snapshot = Awaited<ReturnType<ProductionStoreAuthority["collectArchiveSnapshot"]>>;
export type TrustedBackupWorker = Pick<AutomaticBackupWorkerAuthority, "backupSelection" | "backupRecords" | "publishBackup"> & {
  collectArchiveSnapshot(): Promise<Snapshot>;
  validateArchive(bytes: ArrayBuffer, expected: Snapshot["target"], port: MessagePort): Promise<Awaited<ReturnType<AutomaticBackupWorkerAuthority["validateAuthenticatedArchiveStage"]>>>;
};
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

/** The key vault is a trusted-shell service, never a DB worker dependency.
 * It cannot mint an app identity, choose a namespace, or write an app database. */
export class TrustedBackupRuntime {
  readonly trust: BackupTrustRuntime;
  readonly automatic: AutomaticBackupWorkerCoordinator;
  #metadata: Snapshot["metadata"] | null = null;
  constructor(worker: TrustedBackupWorker) {
    this.trust = new BackupTrustRuntime(new IndexedDbBackupTrustRecordStore(globalThis.indexedDB));
    this.automatic = new AutomaticBackupWorkerCoordinator({
      ...worker,
      backupMetadata: () => {
        if (!this.#metadata) throw new Error("No authority snapshot metadata is available");
        return this.#metadata;
      },
      exportAuthenticatedArchive: async material => {
        const snapshot = await worker.collectArchiveSnapshot();
        try {
          const bytes = sealAuthenticatedArchiveV5(snapshot.bytes, material.backupTrustKey, {
            authenticationVersion: 1, archiveFormat: 5, contentType: CLAY_ARCHIVE_CONTENT_TYPE,
            keyId: material.keyId, seriesId: material.seriesId, generation: material.generation,
          });
          this.#metadata = snapshot.metadata;
          return { ...snapshot, bytes, authentication: {
            schema: 1, kind: "cose_mac0_hmac_256_256", authenticationVersion: 1,
            keyId: hex(material.keyId), seriesId: hex(material.seriesId), generation: material.generation.toString(),
          } };
        } finally { snapshot.bytes.fill(0); }
      },
      validateAuthenticatedArchiveStage: async (bytes, expected) => {
        const channel = new MessageChannel();
        const stop = serveArchiveVerification(channel.port1, this.trust);
        const copy = bytes.slice();
        try { return await worker.validateArchive(copy.buffer, expected, channel.port2); }
        finally { stop(); channel.port2.close(); }
      },
    }, this.trust);
  }
}
