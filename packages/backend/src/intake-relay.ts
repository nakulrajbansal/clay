import {
  IntakeCiphertextEnvelopeV1,
  IntakeRelayDeliveryItemV1,
  MAX_INTAKE_CIPHERTEXT_BYTES,
} from "@clay/schema/intake";
import { timingSafeEqual } from "node:crypto";

export type IntakeRelayRegistrationRecord = Readonly<{
  formId: string;
  ownerTokenSha256: string;
  submitTokenSha256: string;
  publisherIdSha256: string;
  sourceSha256: string;
  expiresAt: string;
  maxCiphertextBytes: number;
}>;

export type IntakeRelaySubmissionRecord = Readonly<{
  formId: string;
  submissionId: string;
  envelope: IntakeCiphertextEnvelopeV1;
  ciphertextBytes: number;
}>;

export type IntakeRelayListResult = Readonly<{
  items: IntakeRelayDeliveryItemV1[];
  hasMore: boolean;
}>;

export const MAX_INTAKE_DELIVERY_PAGE_BYTES =
  Math.ceil(MAX_INTAKE_CIPHERTEXT_BYTES * 4 / 3) + 128 * 1024;

export type IntakeRelayPutResult = Readonly<{
  created: boolean;
  item: IntakeRelayDeliveryItemV1;
}>;

export type IntakeRelayStore = {
  register(record: IntakeRelayRegistrationRecord): Promise<{ created: boolean }>;
  authorizeSubmission(
    formId: string,
    tokenSha256: string,
  ): Promise<{ maxCiphertextBytes: number }>;
  putSubmission(
    tokenSha256: string,
    record: IntakeRelaySubmissionRecord,
  ): Promise<IntakeRelayPutResult>;
  listSubmissions(
    formId: string,
    ownerTokenSha256: string,
    limit: number,
    after: string | null,
    maxWireBytes?: number,
  ): Promise<IntakeRelayListResult>;
  deleteSubmission(
    formId: string,
    submissionId: string,
    ownerTokenSha256: string,
  ): Promise<boolean>;
  revokeForm(formId: string, ownerTokenSha256: string): Promise<boolean>;
  cleanupExpired(): Promise<{ forms: number; submissions: number }>;
};

export type IntakeRelayErrorCode =
  | "unauthorized" | "not_found" | "expired" | "conflict"
  | "item_too_large" | "queue_full" | "capacity" | "invalid";

export class IntakeRelayError extends Error {
  constructor(readonly relayCode: IntakeRelayErrorCode, message: string) {
    super(message);
  }
}

type StoredForm = IntakeRelayRegistrationRecord & {
  createdAt: string;
  revokedAt: string | null;
  submissions: Map<string, IntakeRelayDeliveryItemV1>;
};

export type MemoryIntakeRelayStoreOptions = Readonly<{
  now?: () => number;
  maxForms?: number;
  maxFormsPerPublisher?: number;
  maxFormsPerSource?: number;
  maxRegistrationsPerSourceWindow?: number;
  registrationWindowMs?: number;
  maxPendingPerForm?: number;
  maxTotalCiphertextBytes?: number;
  maxCiphertextBytesPerForm?: number;
  retentionMs?: number;
}>;

function hashMatches(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function cloneItem(item: IntakeRelayDeliveryItemV1): IntakeRelayDeliveryItemV1 {
  return IntakeRelayDeliveryItemV1.parse(JSON.parse(JSON.stringify(item)) as unknown);
}

function itemWireBytes(item: IntakeRelayDeliveryItemV1): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

export class MemoryIntakeRelayStore implements IntakeRelayStore {
  readonly #forms = new Map<string, StoredForm>();
  readonly #clock: () => number;
  readonly #maxForms: number;
  readonly #maxFormsPerPublisher: number;
  readonly #maxFormsPerSource: number;
  readonly #maxRegistrationsPerSourceWindow: number;
  readonly #registrationWindowMs: number;
  readonly #maxPending: number;
  readonly #maxTotalBytes: number;
  readonly #maxBytesPerForm: number;
  readonly #retentionMs: number;
  readonly #registrationEvents: Array<{ sourceSha256: string; at: number }> = [];
  #totalBytes = 0;

  constructor(options: MemoryIntakeRelayStoreOptions = {}) {
    this.#clock = options.now ?? Date.now;
    this.#maxForms = options.maxForms ?? 1_000;
    this.#maxFormsPerPublisher = options.maxFormsPerPublisher ?? 100;
    this.#maxFormsPerSource = options.maxFormsPerSource ?? 100;
    this.#maxRegistrationsPerSourceWindow = options.maxRegistrationsPerSourceWindow ?? 20;
    this.#registrationWindowMs = options.registrationWindowMs ?? 60 * 60_000;
    this.#maxPending = options.maxPendingPerForm ?? 100;
    this.#maxTotalBytes = options.maxTotalCiphertextBytes ?? 64 * 1024 * 1024;
    this.#maxBytesPerForm = options.maxCiphertextBytesPerForm ?? 32 * 1024 * 1024;
    this.#retentionMs = options.retentionMs ?? 7 * 86_400_000;
    for (const [name, value] of [
      ["maxForms", this.#maxForms], ["maxPendingPerForm", this.#maxPending],
      ["maxFormsPerPublisher", this.#maxFormsPerPublisher],
      ["maxFormsPerSource", this.#maxFormsPerSource],
      ["maxRegistrationsPerSourceWindow", this.#maxRegistrationsPerSourceWindow],
      ["registrationWindowMs", this.#registrationWindowMs],
      ["maxTotalCiphertextBytes", this.#maxTotalBytes], ["retentionMs", this.#retentionMs],
      ["maxCiphertextBytesPerForm", this.#maxBytesPerForm],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new IntakeRelayError("invalid", "relay clock is invalid");
    return value;
  }

  #clean(form: StoredForm, now: number): number {
    let submissions = 0;
    for (const [id, item] of form.submissions) {
      if (Date.parse(item.expiresAt) > now) continue;
      this.#totalBytes -= item.ciphertextBytes;
      form.submissions.delete(id);
      submissions++;
    }
    return submissions;
  }

  #cleanAll(now: number): { forms: number; submissions: number } {
    let forms = 0;
    let submissions = 0;
    for (const [formId, form] of this.#forms) {
      submissions += this.#clean(form, now);
      if (form.revokedAt === null && Date.parse(form.expiresAt) > now) continue;
      for (const item of form.submissions.values()) {
        this.#totalBytes -= item.ciphertextBytes;
        submissions++;
      }
      this.#forms.delete(formId);
      forms++;
    }
    const cutoff = now - this.#registrationWindowMs;
    while (this.#registrationEvents[0]?.at !== undefined
        && this.#registrationEvents[0].at <= cutoff) this.#registrationEvents.shift();
    this.#totalBytes = Math.max(0, this.#totalBytes);
    return { forms, submissions };
  }

  #form(formId: string, tokenSha256: string, capability: "owner" | "submit"): StoredForm {
    const now = this.#now();
    this.#cleanAll(now);
    const form = this.#forms.get(formId);
    if (!form) throw new IntakeRelayError("not_found", "intake form was not found");
    const expected = capability === "owner" ? form.ownerTokenSha256 : form.submitTokenSha256;
    if (!hashMatches(expected, tokenSha256))
      throw new IntakeRelayError("unauthorized", "intake capability is invalid");
    if (form.revokedAt !== null || Date.parse(form.expiresAt) <= now)
      throw new IntakeRelayError("expired", "intake form is revoked or expired");
    return form;
  }

  async register(record: IntakeRelayRegistrationRecord): Promise<{ created: boolean }> {
    const now = this.#now();
    this.#cleanAll(now);
    const expiry = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 90 * 86_400_000)
      throw new IntakeRelayError("invalid", "intake form expiry must be within 90 days");
    if (!/^[0-9a-f]{64}$/u.test(record.ownerTokenSha256)
        || !/^[0-9a-f]{64}$/u.test(record.submitTokenSha256)
        || !/^[0-9a-f]{64}$/u.test(record.publisherIdSha256)
        || !/^[0-9a-f]{64}$/u.test(record.sourceSha256)
        || hashMatches(record.ownerTokenSha256, record.submitTokenSha256))
      throw new IntakeRelayError("invalid", "intake capability or allocation hashes are invalid");
    const prior = this.#forms.get(record.formId);
    if (prior) {
      if (!hashMatches(prior.ownerTokenSha256, record.ownerTokenSha256))
        throw new IntakeRelayError("conflict", "intake form identity is already registered");
      const same = prior.submitTokenSha256 === record.submitTokenSha256
        && prior.publisherIdSha256 === record.publisherIdSha256
        && prior.sourceSha256 === record.sourceSha256
        && prior.expiresAt === record.expiresAt
        && prior.maxCiphertextBytes === record.maxCiphertextBytes
        && prior.revokedAt === null;
      if (!same) throw new IntakeRelayError("conflict", "intake form registration does not match");
      return { created: false };
    }
    if (this.#forms.size >= this.#maxForms)
      throw new IntakeRelayError("capacity", "relay form capacity is full");
    const publisherForms = [...this.#forms.values()].filter(form =>
      form.publisherIdSha256 === record.publisherIdSha256).length;
    if (publisherForms >= this.#maxFormsPerPublisher)
      throw new IntakeRelayError("capacity", "publisher intake form quota is full");
    const sourceForms = [...this.#forms.values()].filter(form =>
      form.sourceSha256 === record.sourceSha256).length;
    if (sourceForms >= this.#maxFormsPerSource)
      throw new IntakeRelayError("capacity", "source intake form quota is full");
    const recentSourceRegistrations = this.#registrationEvents.filter(event =>
      event.sourceSha256 === record.sourceSha256).length;
    if (recentSourceRegistrations >= this.#maxRegistrationsPerSourceWindow)
      throw new IntakeRelayError("capacity", "source intake form rate limit reached");
    this.#forms.set(record.formId, {
      ...record, createdAt: new Date(now).toISOString(), revokedAt: null,
      submissions: new Map(),
    });
    this.#registrationEvents.push({ sourceSha256: record.sourceSha256, at: now });
    return { created: true };
  }

  async authorizeSubmission(
    formId: string,
    tokenSha256: string,
  ): Promise<{ maxCiphertextBytes: number }> {
    const form = this.#form(formId, tokenSha256, "submit");
    return { maxCiphertextBytes: form.maxCiphertextBytes };
  }

  async putSubmission(
    tokenSha256: string,
    record: IntakeRelaySubmissionRecord,
  ): Promise<IntakeRelayPutResult> {
    const form = this.#form(record.formId, tokenSha256, "submit");
    if (record.ciphertextBytes > form.maxCiphertextBytes)
      throw new IntakeRelayError("item_too_large", "ciphertext exceeds this form's limit");
    const existing = form.submissions.get(record.submissionId);
    if (existing) {
      const same = existing.ciphertextBytes === record.ciphertextBytes
        && JSON.stringify(existing.envelope) === JSON.stringify(record.envelope);
      if (!same) throw new IntakeRelayError("conflict", "submission identity was reused");
      return { created: false, item: cloneItem(existing) };
    }
    if (form.submissions.size >= this.#maxPending)
      throw new IntakeRelayError("queue_full", "intake queue is full");
    const received = this.#now();
    const expires = Math.min(Date.parse(form.expiresAt), received + this.#retentionMs);
    const item = IntakeRelayDeliveryItemV1.parse({
      schema: 1,
      formId: record.formId,
      submissionId: record.submissionId,
      receivedAt: new Date(received).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      ciphertextBytes: record.ciphertextBytes,
      envelope: record.envelope,
    });
    const formBytes = [...form.submissions.values()].reduce(
      (total, pending) => total + pending.ciphertextBytes, 0,
    );
    if (formBytes + item.ciphertextBytes > this.#maxBytesPerForm)
      throw new IntakeRelayError("capacity", "intake form ciphertext capacity is full");
    if (this.#totalBytes + item.ciphertextBytes > this.#maxTotalBytes)
      throw new IntakeRelayError("capacity", "relay ciphertext capacity is full");
    form.submissions.set(item.submissionId, cloneItem(item));
    this.#totalBytes += item.ciphertextBytes;
    return { created: true, item: cloneItem(item) };
  }

  async listSubmissions(
    formId: string,
    ownerTokenSha256: string,
    limit: number,
    after: string | null,
    maxWireBytes = MAX_INTAKE_DELIVERY_PAGE_BYTES,
  ): Promise<IntakeRelayListResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new IntakeRelayError("invalid", "list limit must be between 1 and 50");
    if (!Number.isSafeInteger(maxWireBytes) || maxWireBytes < 1
        || maxWireBytes > MAX_INTAKE_DELIVERY_PAGE_BYTES)
      throw new IntakeRelayError("invalid", "delivery byte limit is invalid");
    const form = this.#form(formId, ownerTokenSha256, "owner");
    const ordered = [...form.submissions.values()].sort((left, right) =>
      left.receivedAt.localeCompare(right.receivedAt)
      || left.submissionId.localeCompare(right.submissionId));
    let start = 0;
    if (after !== null) {
      const index = ordered.findIndex(item => item.submissionId === after);
      if (index < 0) throw new IntakeRelayError("invalid", "list cursor is invalid");
      start = index + 1;
    }
    const items: IntakeRelayDeliveryItemV1[] = [];
    let bytes = Buffer.byteLength('{"items":[],"hasMore":true}', "utf8");
    for (const candidate of ordered.slice(start, start + limit)) {
      const itemBytes = itemWireBytes(candidate) + (items.length > 0 ? 1 : 0);
      if (bytes + itemBytes > maxWireBytes) break;
      items.push(cloneItem(candidate));
      bytes += itemBytes;
    }
    if (items.length === 0 && ordered.length > start)
      throw new IntakeRelayError("item_too_large", "delivery item exceeds the response byte limit");
    return {
      items,
      hasMore: ordered.length > start + items.length,
    };
  }

  async deleteSubmission(
    formId: string,
    submissionId: string,
    ownerTokenSha256: string,
  ): Promise<boolean> {
    const form = this.#form(formId, ownerTokenSha256, "owner");
    const item = form.submissions.get(submissionId);
    if (!item) return false;
    form.submissions.delete(submissionId);
    this.#totalBytes -= item.ciphertextBytes;
    return true;
  }

  async revokeForm(formId: string, ownerTokenSha256: string): Promise<boolean> {
    const now = this.#now();
    this.#cleanAll(now);
    const form = this.#forms.get(formId);
    if (!form) return false;
    if (!hashMatches(form.ownerTokenSha256, ownerTokenSha256))
      throw new IntakeRelayError("unauthorized", "intake capability is invalid");
    form.revokedAt = new Date(now).toISOString();
    for (const item of form.submissions.values()) this.#totalBytes -= item.ciphertextBytes;
    form.submissions.clear();
    return true;
  }

  async cleanupExpired(): Promise<{ forms: number; submissions: number }> {
    return this.#cleanAll(this.#now());
  }
}

export const RELAY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS intake_relay_forms (
  form_id TEXT PRIMARY KEY,
  owner_token_sha256 TEXT NOT NULL,
  submit_token_sha256 TEXT NOT NULL,
  publisher_id_sha256 TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_ciphertext_bytes INTEGER NOT NULL CHECK (
    max_ciphertext_bytes BETWEEN 1024 AND 12582912
  ),
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
ALTER TABLE intake_relay_forms
  ADD COLUMN IF NOT EXISTS publisher_id_sha256 TEXT NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE intake_relay_forms
  ADD COLUMN IF NOT EXISTS source_sha256 TEXT NOT NULL DEFAULT repeat('0', 64);
CREATE TABLE IF NOT EXISTS intake_relay_submissions (
  form_id TEXT NOT NULL REFERENCES intake_relay_forms(form_id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  envelope_json JSONB NOT NULL,
  ciphertext_bytes INTEGER NOT NULL CHECK (
    ciphertext_bytes BETWEEN 1 AND 12582912
  ),
  received_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(form_id, submission_id)
);
CREATE TABLE IF NOT EXISTS intake_relay_registration_events (
  source_sha256 TEXT NOT NULL,
  publisher_id_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_relay_registration_rate
  ON intake_relay_registration_events(source_sha256, created_at);
CREATE INDEX IF NOT EXISTS intake_relay_active_publisher
  ON intake_relay_forms(publisher_id_sha256, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS intake_relay_active_source
  ON intake_relay_forms(source_sha256, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS intake_relay_delivery_order
  ON intake_relay_submissions(form_id, received_at, submission_id);
`;

export type IntakeRelayPgClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
};
export type IntakeRelayPgPool = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<IntakeRelayPgClient>;
};

function pgInstant(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new IntakeRelayError("invalid", "relay timestamp is invalid");
  return date.toISOString();
}

function pgEnvelope(value: unknown): IntakeCiphertextEnvelopeV1 {
  let decoded = value;
  if (typeof value === "string") {
    try { decoded = JSON.parse(value) as unknown; }
    catch { throw new IntakeRelayError("invalid", "stored ciphertext envelope is invalid"); }
  }
  const parsed = IntakeCiphertextEnvelopeV1.safeParse(decoded);
  if (!parsed.success) throw new IntakeRelayError("invalid", "stored ciphertext envelope is invalid");
  return parsed.data;
}

/** Durable PostgreSQL adapter. A fixed advisory transaction lock makes count
 * and byte ceilings exact across forms and serverless instances. */
export class PostgresIntakeRelayStore implements IntakeRelayStore {
  readonly #pool: IntakeRelayPgPool;
  readonly #clock: () => number;
  readonly #maxForms: number;
  readonly #maxFormsPerPublisher: number;
  readonly #maxFormsPerSource: number;
  readonly #maxRegistrationsPerSourceWindow: number;
  readonly #registrationWindowMs: number;
  readonly #maxPending: number;
  readonly #maxTotalBytes: number;
  readonly #maxBytesPerForm: number;
  readonly #retentionMs: number;

  constructor(pool: IntakeRelayPgPool, options: MemoryIntakeRelayStoreOptions = {}) {
    if (typeof pool?.connect !== "function") throw new Error("Postgres relay requires transactions");
    this.#pool = pool;
    this.#clock = options.now ?? Date.now;
    this.#maxForms = options.maxForms ?? 100_000;
    this.#maxFormsPerPublisher = options.maxFormsPerPublisher ?? 100;
    this.#maxFormsPerSource = options.maxFormsPerSource ?? 100;
    this.#maxRegistrationsPerSourceWindow = options.maxRegistrationsPerSourceWindow ?? 20;
    this.#registrationWindowMs = options.registrationWindowMs ?? 60 * 60_000;
    this.#maxPending = options.maxPendingPerForm ?? 100;
    this.#maxTotalBytes = options.maxTotalCiphertextBytes ?? 10 * 1024 * 1024 * 1024;
    this.#maxBytesPerForm = options.maxCiphertextBytesPerForm ?? 32 * 1024 * 1024;
    this.#retentionMs = options.retentionMs ?? 7 * 86_400_000;
    for (const value of [
      this.#maxForms, this.#maxFormsPerPublisher, this.#maxFormsPerSource,
      this.#maxRegistrationsPerSourceWindow, this.#registrationWindowMs,
      this.#maxPending, this.#maxTotalBytes, this.#maxBytesPerForm, this.#retentionMs,
    ])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("relay limits must be positive integers");
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new IntakeRelayError("invalid", "relay clock is invalid");
    return value;
  }

  async #cleanup(
    client: IntakeRelayPgClient,
    now: number,
  ): Promise<{ forms: number; submissions: number }> {
    const at = new Date(now).toISOString();
    const submissions = await client.query(
      "DELETE FROM intake_relay_submissions WHERE expires_at <= $1 RETURNING submission_id",
      [at],
    );
    const forms = await client.query(
      `DELETE FROM intake_relay_forms
       WHERE revoked_at IS NOT NULL OR expires_at <= $1 RETURNING form_id`,
      [at],
    );
    await client.query(
      "DELETE FROM intake_relay_registration_events WHERE created_at <= $1",
      [new Date(now - this.#registrationWindowMs).toISOString()],
    );
    return { forms: forms.rows.length, submissions: submissions.rows.length };
  }

  async #transaction<T>(
    now: number,
    run: (
      client: IntakeRelayPgClient,
      cleanup: { forms: number; submissions: number },
    ) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1129072972)");
      const cleanup = await this.#cleanup(client, now);
      const value = await run(client, cleanup);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(RELAY_SCHEMA_SQL);
  }

  async #lockedForm(
    client: IntakeRelayPgClient,
    formId: string,
    tokenSha256: string,
    capability: "owner" | "submit",
    now: number,
  ): Promise<Record<string, unknown>> {
    const row = (await client.query(
      "SELECT * FROM intake_relay_forms WHERE form_id = $1 FOR UPDATE", [formId],
    )).rows[0];
    if (!row) throw new IntakeRelayError("not_found", "intake form was not found");
    const expected = String(capability === "owner" ? row.owner_token_sha256 : row.submit_token_sha256);
    if (!hashMatches(expected, tokenSha256))
      throw new IntakeRelayError("unauthorized", "intake capability is invalid");
    if ((row.revoked_at !== null && row.revoked_at !== undefined)
        || Date.parse(pgInstant(row.expires_at)) <= now)
      throw new IntakeRelayError("expired", "intake form is revoked or expired");
    return row;
  }

  async register(record: IntakeRelayRegistrationRecord): Promise<{ created: boolean }> {
    const now = this.#now();
    const expiry = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 90 * 86_400_000
        || !/^[0-9a-f]{64}$/u.test(record.ownerTokenSha256)
        || !/^[0-9a-f]{64}$/u.test(record.submitTokenSha256)
        || !/^[0-9a-f]{64}$/u.test(record.publisherIdSha256)
        || !/^[0-9a-f]{64}$/u.test(record.sourceSha256)
        || hashMatches(record.ownerTokenSha256, record.submitTokenSha256))
      throw new IntakeRelayError("invalid", "intake form registration is invalid");
    return this.#transaction(now, async client => {
      const prior = (await client.query(
        "SELECT * FROM intake_relay_forms WHERE form_id = $1 FOR UPDATE", [record.formId],
      )).rows[0];
      if (prior) {
        if (!hashMatches(String(prior.owner_token_sha256), record.ownerTokenSha256)
            || String(prior.submit_token_sha256) !== record.submitTokenSha256
            || String(prior.publisher_id_sha256) !== record.publisherIdSha256
            || String(prior.source_sha256) !== record.sourceSha256
            || pgInstant(prior.expires_at) !== record.expiresAt
            || Number(prior.max_ciphertext_bytes) !== record.maxCiphertextBytes
            || (prior.revoked_at !== null && prior.revoked_at !== undefined))
          throw new IntakeRelayError("conflict", "intake form registration does not match");
        return { created: false };
      }
      const at = new Date(now).toISOString();
      const count = Number((await client.query(
        `SELECT COUNT(*) AS n FROM intake_relay_forms
         WHERE revoked_at IS NULL AND expires_at > $1`, [at],
      )).rows[0]?.n ?? 0);
      if (!Number.isSafeInteger(count) || count >= this.#maxForms)
        throw new IntakeRelayError("capacity", "relay form capacity is full");
      const publisherCount = Number((await client.query(
        `SELECT COUNT(*) AS n FROM intake_relay_forms
         WHERE publisher_id_sha256 = $1 AND revoked_at IS NULL AND expires_at > $2`,
        [record.publisherIdSha256, at],
      )).rows[0]?.n ?? 0);
      if (!Number.isSafeInteger(publisherCount) || publisherCount >= this.#maxFormsPerPublisher)
        throw new IntakeRelayError("capacity", "publisher intake form quota is full");
      const sourceCount = Number((await client.query(
        `SELECT COUNT(*) AS n FROM intake_relay_forms
         WHERE source_sha256 = $1 AND revoked_at IS NULL AND expires_at > $2`,
        [record.sourceSha256, at],
      )).rows[0]?.n ?? 0);
      if (!Number.isSafeInteger(sourceCount) || sourceCount >= this.#maxFormsPerSource)
        throw new IntakeRelayError("capacity", "source intake form quota is full");
      const recentSource = Number((await client.query(
        `SELECT COUNT(*) AS n FROM intake_relay_registration_events
         WHERE source_sha256 = $1 AND created_at > $2`,
        [record.sourceSha256, new Date(now - this.#registrationWindowMs).toISOString()],
      )).rows[0]?.n ?? 0);
      if (!Number.isSafeInteger(recentSource)
          || recentSource >= this.#maxRegistrationsPerSourceWindow)
        throw new IntakeRelayError("capacity", "source intake form rate limit reached");
      await client.query(
        `INSERT INTO intake_relay_forms(
          form_id, owner_token_sha256, submit_token_sha256,
          publisher_id_sha256, source_sha256, expires_at,
          max_ciphertext_bytes, created_at, revoked_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
        [record.formId, record.ownerTokenSha256, record.submitTokenSha256,
         record.publisherIdSha256, record.sourceSha256, record.expiresAt,
         record.maxCiphertextBytes, at],
      );
      await client.query(
        `INSERT INTO intake_relay_registration_events(
          source_sha256, publisher_id_sha256, created_at
        ) VALUES ($1, $2, $3)`,
        [record.sourceSha256, record.publisherIdSha256, at],
      );
      return { created: true };
    });
  }

  async authorizeSubmission(
    formId: string,
    tokenSha256: string,
  ): Promise<{ maxCiphertextBytes: number }> {
    const now = this.#now();
    return this.#transaction(now, async client => {
      const form = await this.#lockedForm(client, formId, tokenSha256, "submit", now);
      const maxCiphertextBytes = Number(form.max_ciphertext_bytes);
      if (!Number.isSafeInteger(maxCiphertextBytes)
          || maxCiphertextBytes < 1 || maxCiphertextBytes > MAX_INTAKE_CIPHERTEXT_BYTES)
        throw new IntakeRelayError("invalid", "stored intake form limit is invalid");
      return { maxCiphertextBytes };
    });
  }

  #itemFromRow(formId: string, row: Record<string, unknown>): IntakeRelayDeliveryItemV1 {
    return IntakeRelayDeliveryItemV1.parse({
      schema: 1,
      formId,
      submissionId: String(row.submission_id),
      receivedAt: pgInstant(row.received_at),
      expiresAt: pgInstant(row.expires_at),
      ciphertextBytes: Number(row.ciphertext_bytes),
      envelope: pgEnvelope(row.envelope_json),
    });
  }

  async putSubmission(
    tokenSha256: string,
    record: IntakeRelaySubmissionRecord,
  ): Promise<IntakeRelayPutResult> {
    const now = this.#now();
    return this.#transaction(now, async client => {
      const form = await this.#lockedForm(client, record.formId, tokenSha256, "submit", now);
      if (record.ciphertextBytes > Number(form.max_ciphertext_bytes))
        throw new IntakeRelayError("item_too_large", "ciphertext exceeds this form's limit");
      const priorRow = (await client.query(
        `SELECT submission_id, envelope_json, ciphertext_bytes, received_at, expires_at
         FROM intake_relay_submissions WHERE form_id = $1 AND submission_id = $2`,
        [record.formId, record.submissionId],
      )).rows[0];
      if (priorRow) {
        const prior = this.#itemFromRow(record.formId, priorRow);
        if (prior.ciphertextBytes !== record.ciphertextBytes
            || JSON.stringify(prior.envelope) !== JSON.stringify(record.envelope))
          throw new IntakeRelayError("conflict", "submission identity was reused");
        return { created: false, item: prior };
      }
      const formUsage = (await client.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(ciphertext_bytes), 0) AS bytes
         FROM intake_relay_submissions WHERE form_id = $1`,
        [record.formId],
      )).rows[0];
      const pending = Number(formUsage?.n ?? 0);
      if (!Number.isSafeInteger(pending) || pending >= this.#maxPending)
        throw new IntakeRelayError("queue_full", "intake queue is full");
      const formBytes = Number(formUsage?.bytes ?? 0);
      if (!Number.isSafeInteger(formBytes)
          || formBytes + record.ciphertextBytes > this.#maxBytesPerForm)
        throw new IntakeRelayError("capacity", "intake form ciphertext capacity is full");
      const total = Number((await client.query(
        "SELECT COALESCE(SUM(ciphertext_bytes), 0) AS n FROM intake_relay_submissions",
      )).rows[0]?.n ?? 0);
      if (!Number.isSafeInteger(total) || total + record.ciphertextBytes > this.#maxTotalBytes)
        throw new IntakeRelayError("capacity", "relay ciphertext capacity is full");
      const receivedAt = new Date(now).toISOString();
      const expiresAt = new Date(Math.min(
        Date.parse(pgInstant(form.expires_at)), now + this.#retentionMs,
      )).toISOString();
      await client.query(
        `INSERT INTO intake_relay_submissions(
          form_id, submission_id, envelope_json, ciphertext_bytes, received_at, expires_at
        ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
        [record.formId, record.submissionId, JSON.stringify(record.envelope),
         record.ciphertextBytes, receivedAt, expiresAt],
      );
      return { created: true, item: IntakeRelayDeliveryItemV1.parse({
        schema: 1, formId: record.formId, submissionId: record.submissionId,
        receivedAt, expiresAt, ciphertextBytes: record.ciphertextBytes,
        envelope: record.envelope,
      }) };
    });
  }

  async listSubmissions(
    formId: string,
    ownerTokenSha256: string,
    limit: number,
    after: string | null,
    maxWireBytes = MAX_INTAKE_DELIVERY_PAGE_BYTES,
  ): Promise<IntakeRelayListResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new IntakeRelayError("invalid", "list limit must be between 1 and 50");
    if (!Number.isSafeInteger(maxWireBytes) || maxWireBytes < 1
        || maxWireBytes > MAX_INTAKE_DELIVERY_PAGE_BYTES)
      throw new IntakeRelayError("invalid", "delivery byte limit is invalid");
    const now = this.#now();
    return this.#transaction(now, async client => {
      await this.#lockedForm(client, formId, ownerTokenSha256, "owner", now);
      let afterReceivedAt: string | null = null;
      if (after !== null) {
        const cursor = (await client.query(
          `SELECT received_at FROM intake_relay_submissions
           WHERE form_id = $1 AND submission_id = $2`, [formId, after],
        )).rows[0];
        if (!cursor) throw new IntakeRelayError("invalid", "list cursor is invalid");
        afterReceivedAt = pgInstant(cursor.received_at);
      }
      const baseBytes = Buffer.byteLength('{"items":[],"hasMore":true}', "utf8");
      const rows = (await client.query(
        `WITH candidates AS (
           SELECT submission_id, envelope_json, ciphertext_bytes, received_at, expires_at,
             octet_length(envelope_json::text) + 1024 AS conservative_wire_bytes
           FROM intake_relay_submissions
           WHERE form_id = $1
             AND ($2::timestamptz IS NULL OR received_at > $2::timestamptz
               OR (received_at = $2::timestamptz AND submission_id > $3))
           ORDER BY received_at, submission_id
           LIMIT $4
         ), bounded AS (
           SELECT *, SUM(conservative_wire_bytes) OVER (
             ORDER BY received_at, submission_id
           ) AS cumulative_wire_bytes
           FROM candidates
         )
         SELECT submission_id, envelope_json, ciphertext_bytes, received_at, expires_at
         FROM bounded WHERE cumulative_wire_bytes + $5 <= $6
         ORDER BY received_at, submission_id`,
        [formId, afterReceivedAt, after, limit, baseBytes, maxWireBytes],
      )).rows;
      const items: IntakeRelayDeliveryItemV1[] = [];
      let bytes = baseBytes;
      for (const row of rows) {
        const item = this.#itemFromRow(formId, row);
        const nextBytes = itemWireBytes(item) + (items.length > 0 ? 1 : 0);
        if (bytes + nextBytes > maxWireBytes) break;
        items.push(item);
        bytes += nextBytes;
      }
      if (items.length === 0) {
        const remaining = (await client.query(
          `SELECT submission_id FROM intake_relay_submissions
           WHERE form_id = $1
             AND ($2::timestamptz IS NULL OR received_at > $2::timestamptz
               OR (received_at = $2::timestamptz AND submission_id > $3))
           ORDER BY received_at, submission_id LIMIT 1`,
          [formId, afterReceivedAt, after],
        )).rows.length > 0;
        if (remaining)
          throw new IntakeRelayError("item_too_large", "delivery item exceeds the response byte limit");
        return { items: [], hasMore: false };
      }
      const last = items.at(-1)!;
      const hasMore = (await client.query(
        `SELECT submission_id FROM intake_relay_submissions
         WHERE form_id = $1 AND (received_at > $2
           OR (received_at = $2 AND submission_id > $3))
         ORDER BY received_at, submission_id LIMIT 1`,
        [formId, last.receivedAt, last.submissionId],
      )).rows.length > 0;
      return { items, hasMore };
    });
  }

  async deleteSubmission(
    formId: string,
    submissionId: string,
    ownerTokenSha256: string,
  ): Promise<boolean> {
    const now = this.#now();
    return this.#transaction(now, async client => {
      await this.#lockedForm(client, formId, ownerTokenSha256, "owner", now);
      const result = await client.query(
        `DELETE FROM intake_relay_submissions WHERE form_id = $1 AND submission_id = $2
         RETURNING submission_id`, [formId, submissionId],
      );
      return result.rows.length === 1;
    });
  }

  async revokeForm(formId: string, ownerTokenSha256: string): Promise<boolean> {
    const now = this.#now();
    return this.#transaction(now, async client => {
      const form = (await client.query(
        "SELECT * FROM intake_relay_forms WHERE form_id = $1 FOR UPDATE", [formId],
      )).rows[0];
      if (!form) return false;
      if (!hashMatches(String(form.owner_token_sha256), ownerTokenSha256))
        throw new IntakeRelayError("unauthorized", "intake capability is invalid");
      if ((form.revoked_at !== null && form.revoked_at !== undefined)
          || Date.parse(pgInstant(form.expires_at)) <= now) return false;
      const at = new Date(now).toISOString();
      const result = await client.query(
        `UPDATE intake_relay_forms SET revoked_at = $2
         WHERE form_id = $1 AND revoked_at IS NULL RETURNING form_id`, [formId, at],
      );
      await client.query("DELETE FROM intake_relay_submissions WHERE form_id = $1", [formId]);
      return result.rows.length === 1;
    });
  }

  async cleanupExpired(): Promise<{ forms: number; submissions: number }> {
    const now = this.#now();
    return this.#transaction(now, async (_client, cleanup) => cleanup);
  }
}
