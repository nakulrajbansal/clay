import { ClayError } from "./errors";

export const PRODUCTION_MUTATION_PREFIX = "production mutation ";
export const PRODUCTION_REQUEST_PREFIX = "production request ";
export const FIXED_OPERATIONAL_MUTATION_PREFIX = "fixed operational mutation ";
export const SAMPLE_PROVENANCE_PREFIX = "sample provenance ";
export const STARTER_SEED_PREFIX = "starter seed ";
export const TABLE_IMPORT_PREFIX = "table import ";

export function targetAuthorityInvalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}
