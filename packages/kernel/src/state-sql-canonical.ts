import { ClayError } from "./errors";
import { stateLeafHashV1, type StateLeafFieldV1 } from "./state-merkle";

function invalid(): ClayError {
  return new ClayError("E_STATE_DIGEST_INVALID", "SQLite value cannot be represented in canonical state");
}

function checked(field: StateLeafFieldV1): StateLeafFieldV1 {
  try {
    stateLeafHashV1("validation", [field]);
    return field;
  } catch {
    throw invalid();
  }
}

export function canonicalSqlFieldV1(
  name: string,
  declaredType: string,
  value: string | number | bigint | Uint8Array | null,
): StateLeafFieldV1 {
  if (declaredType !== "TEXT" && declaredType !== "INTEGER" && declaredType !== "REAL")
    throw invalid();
  if (value === null) return checked({ name, kind: "null" });
  if (declaredType === "TEXT") {
    if (typeof value !== "string") throw invalid();
    return checked({ name, kind: "text", value });
  }
  if (declaredType === "INTEGER") {
    if (typeof value === "bigint")
      return checked({ name, kind: "integer", value: value.toString() });
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid();
    const normalized = Object.is(value, -0) ? 0 : value;
    return checked({ name, kind: "integer", value: normalized.toString() });
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
  return checked({ name, kind: "real", value: Object.is(value, -0) ? 0 : value });
}

export function canonicalContentFieldV1(
  name: string,
  sha256: string,
  bytes: string,
): StateLeafFieldV1 {
  return checked({ name, kind: "content", sha256, bytes });
}
