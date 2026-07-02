// ClayError: the only error shape that crosses kernel boundaries (doc 03 §0).
export type ClayErrorCode =
  | "E_TABLE_UNKNOWN"
  | "E_COLUMN_UNKNOWN"
  | "E_VALIDATION"
  | "E_LIMIT"
  | "E_TYPE"
  | "E_EXPR"
  | "E_INTERNAL";

export class ClayError extends Error {
  constructor(
    readonly code: ClayErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ClayError";
  }
}

export function expectClay(cond: boolean, code: ClayErrorCode, msg: string): asserts cond {
  if (!cond) throw new ClayError(code, msg);
}
