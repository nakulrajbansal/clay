/** Presentation conversion only: no logging, persistence, sanitization or retry. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
