import {
  GenerationId,
  OperationId,
  TargetAuthorityHeaderV1,
  TargetEvidenceV1,
  UInt64Decimal,
} from "@clay/schema";
import type {
  TargetAuthorityHeaderV1 as TargetAuthorityHeader,
  TargetEvidenceV1 as TargetEvidence,
} from "@clay/schema";
import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import { StateMerkleIndex } from "./state-merkle-index";

const HEADER_TABLE = "target_authority_header";
const RESERVATION_TABLE = "target_revision_reservations";
const TABLES = [HEADER_TABLE, RESERVATION_TABLE] as const;
const DDL = [
  `CREATE TABLE sys.target_authority_header(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  app_instance_id TEXT NOT NULL,
  active_generation_id TEXT NOT NULL,
  lineage_epoch TEXT NOT NULL,
  lineage_epoch_high_water TEXT NOT NULL,
  protection_revision TEXT NOT NULL,
  protection_revision_high_water TEXT NOT NULL,
  digest_schema INTEGER NOT NULL CHECK(digest_schema = 1)
)`,
  `CREATE TABLE sys.target_revision_reservations(
  revision TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  active_generation_id TEXT NOT NULL,
  lineage_epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','committed','abandoned')),
  reserved_at TEXT NOT NULL,
  finalized_at TEXT
)`,
] as const;

function invalid(message = "target authority metadata is invalid"): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function exactSchema(driver: DbDriver): boolean {
  try {
    const placeholders = TABLES.map(() => "?").join(",");
    const rows = driver.select(
      `SELECT type, name, tbl_name, sql FROM sys.sqlite_master
       WHERE name IN (${placeholders}) OR tbl_name IN (${placeholders}) ORDER BY name`,
      [...TABLES, ...TABLES],
    );
    const definitions = new Map(DDL.map(ddl => {
      const match = /^CREATE TABLE sys\.([a-z_]+)\(/.exec(ddl);
      if (!match) throw invalid();
      return [match[1]!, normalized(ddl.replace("CREATE TABLE sys.", "CREATE TABLE "))];
    }));
    const expectedNames = [
      HEADER_TABLE,
      RESERVATION_TABLE,
      `sqlite_autoindex_${RESERVATION_TABLE}_1`,
      `sqlite_autoindex_${RESERVATION_TABLE}_2`,
    ].sort();
    if (rows.length !== expectedNames.length
        || rows.some((row, index) => row.name !== expectedNames[index])) return false;
    return rows.every(row => {
      if (row.type === "table")
        return row.tbl_name === row.name
          && definitions.get(String(row.name)) === normalized(String(row.sql));
      return row.type === "index" && row.tbl_name === RESERVATION_TABLE && row.sql === null;
    });
  } catch {
    return false;
  }
}

function readHeader(driver: DbDriver): TargetAuthorityHeader {
  try {
    const rows = driver.select(`SELECT * FROM sys.${HEADER_TABLE}`);
    if (rows.length !== 1 || Number(rows[0]!.singleton) !== 1
        || Number(rows[0]!.schema_version) !== 1) throw invalid();
    return TargetAuthorityHeaderV1.parse({
      schema: 1,
      appInstanceId: rows[0]!.app_instance_id,
      activeGenerationId: rows[0]!.active_generation_id,
      lineageEpoch: rows[0]!.lineage_epoch,
      lineageEpochHighWater: rows[0]!.lineage_epoch_high_water,
      protectionRevision: rows[0]!.protection_revision,
      protectionRevisionHighWater: rows[0]!.protection_revision_high_water,
      digestSchema: rows[0]!.digest_schema,
    });
  } catch (error) {
    if (error instanceof ClayError && error.code === "E_TARGET_AUTHORITY_INVALID") throw error;
    throw invalid();
  }
}

export type ProtectionRevisionReservation = {
  operationId: string;
  revision: string;
  state: "reserved" | "committed" | "abandoned";
  reservedAt: string;
  finalizedAt: string | null;
};
export type ProtectionRevisionReservationResult = Pick<
  ProtectionRevisionReservation, "revision" | "state"
>;

const UINT64_MAX = 18_446_744_073_709_551_615n;

function canonicalInstant(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) throw invalid("reservation time is invalid");
  return value;
}

function readReservations(
  driver: DbDriver,
  header: TargetAuthorityHeader,
): ProtectionRevisionReservation[] {
  const rows = driver.select(`SELECT * FROM sys.${RESERVATION_TABLE}`);
  const reservations = rows.map(row => {
    const revision = UInt64Decimal.parse(row.revision);
    const operationId = OperationId.parse(row.operation_id);
    const generationId = GenerationId.parse(row.active_generation_id);
    const lineageEpoch = UInt64Decimal.parse(row.lineage_epoch);
    const state = row.state;
    if (revision === "0" || generationId !== header.activeGenerationId
        || lineageEpoch !== header.lineageEpoch
        || (state !== "reserved" && state !== "committed" && state !== "abandoned"))
      throw invalid("revision reservation is invalid");
    const reservedAt = canonicalInstant(row.reserved_at);
    const finalizedAt = row.finalized_at === null ? null : canonicalInstant(row.finalized_at);
    if ((state === "reserved") !== (finalizedAt === null))
      throw invalid("revision reservation finalization is invalid");
    return {
      operationId,
      revision,
      state: state as ProtectionRevisionReservation["state"],
      reservedAt,
      finalizedAt,
    };
  }).sort((left, right) => BigInt(left.revision) < BigInt(right.revision) ? -1 : 1);
  const highWater = BigInt(header.protectionRevisionHighWater);
  const current = BigInt(header.protectionRevision);
  if (BigInt(reservations.length) !== highWater
      || reservations.some(reservation => BigInt(reservation.revision) > highWater)
      || reservations.some(reservation => reservation.state === "committed"
        && BigInt(reservation.revision) > current)
      || reservations.some(reservation => reservation.state === "reserved"
        && BigInt(reservation.revision) <= current)
      || (current > 0n && !reservations.some(reservation =>
        reservation.state === "committed" && BigInt(reservation.revision) === current))
      || (reservations.length === 0 && header.protectionRevision !== header.protectionRevisionHighWater)
      || (reservations.length > 0 && BigInt(reservations.at(-1)!.revision) !== highWater))
    throw invalid("revision reservation high-water is inconsistent");
  return reservations;
}

export class TargetAuthorityStore {
  private constructor(private readonly driver: DbDriver) {}

  static createSchema(driver: DbDriver): void {
    try {
      const placeholders = TABLES.map(() => "?").join(",");
      const existing = driver.select(
        `SELECT name FROM sys.sqlite_master
         WHERE name IN (${placeholders}) OR tbl_name IN (${placeholders})`,
        [...TABLES, ...TABLES],
      );
      if (existing.length !== 0) throw invalid("target authority schema already exists");
      driver.tx(() => { for (const ddl of DDL) driver.exec(ddl); });
      if (!exactSchema(driver)) throw invalid("target authority schema failed read-back");
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_TARGET_AUTHORITY_INVALID") throw error;
      throw invalid("target authority schema creation failed");
    }
  }

  static initialize(driver: DbDriver, input: TargetAuthorityHeader): TargetAuthorityStore {
    const header = TargetAuthorityHeaderV1.safeParse(input);
    if (!header.success || !exactSchema(driver)) throw invalid();
    const target = new TargetAuthorityStore(driver);
    try {
      driver.tx(() => {
        const count = driver.select(`SELECT count(*) AS n FROM sys.${HEADER_TABLE}`);
        if (count.length !== 1 || Number(count[0]!.n) !== 0)
          throw invalid("target authority is already initialized");
        driver.exec(
          `INSERT INTO sys.${HEADER_TABLE}(
             singleton,schema_version,app_instance_id,active_generation_id,
             lineage_epoch,lineage_epoch_high_water,protection_revision,
             protection_revision_high_water,digest_schema)
           VALUES (1,1,?,?,?,?,?,?,1)`,
          [
            header.data.appInstanceId,
            header.data.activeGenerationId,
            header.data.lineageEpoch,
            header.data.lineageEpochHighWater,
            header.data.protectionRevision,
            header.data.protectionRevisionHighWater,
          ],
        );
        if (JSON.stringify(readHeader(driver)) !== JSON.stringify(header.data))
          throw invalid("target authority initialization failed read-back");
        readReservations(driver, header.data);
      });
      return target;
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_TARGET_AUTHORITY_INVALID") throw error;
      throw invalid("target authority initialization failed");
    }
  }

  static open(driver: DbDriver): TargetAuthorityStore {
    if (!exactSchema(driver)) throw invalid();
    const header = readHeader(driver);
    readReservations(driver, header);
    return new TargetAuthorityStore(driver);
  }

  header(): TargetAuthorityHeader {
    return this.driver.tx(() => readHeader(this.driver));
  }

  reservations(): ProtectionRevisionReservation[] {
    return this.driver.tx(() => {
      const header = readHeader(this.driver);
      return readReservations(this.driver, header);
    });
  }

  reserveProtectionRevision(
    operationIdInput: string,
    reservedAtInput: string,
  ): ProtectionRevisionReservationResult {
    const operation = OperationId.safeParse(operationIdInput);
    if (!operation.success || !exactSchema(this.driver)) throw invalid();
    const reservedAt = canonicalInstant(reservedAtInput);
    try {
      return this.driver.tx(() => {
        const header = readHeader(this.driver);
        const existing = readReservations(this.driver, header)
          .find(reservation => reservation.operationId === operation.data);
        if (existing) return { revision: existing.revision, state: existing.state };
        const highWater = BigInt(header.protectionRevisionHighWater);
        if (highWater === UINT64_MAX) throw invalid("protection revision is exhausted");
        const revision = String(highWater + 1n);
        this.driver.exec(
          `UPDATE sys.${HEADER_TABLE} SET protection_revision_high_water = ?
           WHERE singleton = 1 AND protection_revision_high_water = ?`,
          [revision, header.protectionRevisionHighWater],
        );
        this.driver.exec(
          `INSERT INTO sys.${RESERVATION_TABLE}(
             revision,operation_id,active_generation_id,lineage_epoch,state,reserved_at,finalized_at)
           VALUES (?,?,?,?,'reserved',?,NULL)`,
          [revision, operation.data, header.activeGenerationId, header.lineageEpoch, reservedAt],
        );
        const updatedHeader = readHeader(this.driver);
        const reservation = readReservations(this.driver, updatedHeader)
          .find(candidate => candidate.operationId === operation.data);
        if (!reservation || updatedHeader.protectionRevisionHighWater !== revision)
          throw invalid("protection revision reservation failed read-back");
        return { revision: reservation.revision, state: reservation.state };
      });
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_TARGET_AUTHORITY_INVALID") throw error;
      throw invalid("protection revision reservation failed");
    }
  }

  abandonProtectionRevision(
    operationIdInput: string,
    finalizedAtInput: string,
  ): ProtectionRevisionReservationResult {
    const operation = OperationId.safeParse(operationIdInput);
    if (!operation.success || !exactSchema(this.driver)) throw invalid();
    const finalizedAt = canonicalInstant(finalizedAtInput);
    try {
      return this.driver.tx(() => {
        const header = readHeader(this.driver);
        const existing = readReservations(this.driver, header)
          .find(reservation => reservation.operationId === operation.data);
        if (!existing) throw invalid("revision reservation is missing");
        if (existing.state === "abandoned")
          return { revision: existing.revision, state: existing.state };
        if (existing.state !== "reserved" || finalizedAt < existing.reservedAt)
          throw invalid("revision reservation cannot be abandoned");
        this.driver.exec(
          `UPDATE sys.${RESERVATION_TABLE}
           SET state = 'abandoned', finalized_at = ?
           WHERE operation_id = ? AND state = 'reserved'`,
          [finalizedAt, operation.data],
        );
        const updated = readReservations(this.driver, readHeader(this.driver))
          .find(reservation => reservation.operationId === operation.data);
        if (!updated || updated.state !== "abandoned" || updated.finalizedAt !== finalizedAt)
          throw invalid("revision abandonment failed read-back");
        return { revision: updated.revision, state: updated.state };
      });
    } catch (error) {
      if (error instanceof ClayError && error.code === "E_TARGET_AUTHORITY_INVALID") throw error;
      throw invalid("revision abandonment failed");
    }
  }

  evidence(): TargetEvidence {
    return this.driver.tx(() => {
      const header = readHeader(this.driver);
      readReservations(this.driver, header);
      const state = StateMerkleIndex.open(this.driver).audit();
      return TargetEvidenceV1.parse({
        appInstanceId: header.appInstanceId,
        activeGenerationId: header.activeGenerationId,
        lineageEpoch: header.lineageEpoch,
        protectionRevision: header.protectionRevision,
        digestSchema: header.digestSchema,
        stateSha256: state.stateSha256,
      });
    });
  }
}
