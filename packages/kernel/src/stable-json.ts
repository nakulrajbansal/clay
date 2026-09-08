type JsonRecord = Readonly<Record<string, unknown>>;

/** Canonical JSON for already-captured JSON-compatible values. */
export function stableJson(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key =>
        [key, (value as JsonRecord)[key]]))
      : value)!;
}
