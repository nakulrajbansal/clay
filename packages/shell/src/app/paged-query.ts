import type { AsyncStore, Query, QueryRow } from "@clay/kernel";

export async function loadAllTableRows(
  store: AsyncStore,
  table: string,
  options: {
    deleted?: boolean;
    where?: NonNullable<Query["where"]>;
    maxRows?: number;
  } = {},
): Promise<QueryRow[]> {
  const pageSize = 500;
  const maxRows = options.maxRows ?? 20_000;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1)
    throw new Error("The row limit must be a positive safe integer.");
  const rows: QueryRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const remaining = maxRows - rows.length;
    const requestLimit = Math.min(pageSize, remaining + 1);
    const where: NonNullable<Query["where"]> = [...(options.where ?? [])];
    if (options.deleted) where.push({ field: "deleted_at", op: "not_null" });
    if (cursor) where.push({ field: "id", op: "gt", value: cursor });
    const page = await store.query({
      from: table,
      ...(options.deleted ? { includeDeleted: true } : {}),
      ...(where.length ? { where } : {}),
      orderBy: [{ field: "id", dir: "asc" }],
      limit: requestLimit,
    });
    if (page.length > remaining)
      throw new Error(`This surface is limited to ${maxRows.toLocaleString()} rows; narrow the table first.`);
    rows.push(...page);
    if (page.length < requestLimit) return rows;
    cursor = String(page.at(-1)!.id);
  }
}
