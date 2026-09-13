/** Test-only atomic structured-clone vault. Never connected to user storage. */
export class MemoryBackupTrustStore {
  readonly rows = new Map<string, { revision: string }>();
  readonly candidates = new Map<string, { revision: string }>();
  active: { revision: string; seriesId: string } | null = null;
  async load(seriesId: string) { return structuredClone(this.rows.get(seriesId) ?? null); }
  async compareAndSet(seriesId: string, revision: string | null, next: unknown) {
    if ((this.rows.get(seriesId)?.revision ?? null) !== revision) return false;
    this.rows.set(seriesId, structuredClone(next) as { revision: string }); return true;
  }
  async loadActiveSeries() { return structuredClone(this.active); }
  async compareAndSetActiveSeries(revision: string | null, seriesId: string) {
    if ((this.active?.revision ?? null) !== revision) return false;
    this.active = { revision: String(BigInt(revision ?? "-1") + 1n), seriesId }; return true;
  }
  async loadAutomaticBackupCandidate(seriesId: string) { return structuredClone(this.candidates.get(seriesId) ?? null); }
  async compareAndSetAutomaticBackupCandidate(seriesId: string, revision: string | null, next: unknown) {
    if ((this.candidates.get(seriesId)?.revision ?? null) !== revision) return false;
    this.candidates.set(seriesId, structuredClone(next) as { revision: string }); return true;
  }
  async removeAutomaticBackupCandidate(seriesId: string, revision: string) {
    if (this.candidates.get(seriesId)?.revision !== revision) return false;
    return this.candidates.delete(seriesId);
  }
}
