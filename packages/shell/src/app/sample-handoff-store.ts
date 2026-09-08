import type { AsyncStore, Query, QueryRow, RegTable } from "@clay/kernel";

/** Routes live record edits through the worker-owned atomic sample-to-real
 * handoff while preserving the ordinary Store RPC for every other operation. */
export class SampleHandoffStore implements AsyncStore {
  constructor(
    private readonly delegate: AsyncStore,
    private readonly updateWithHandoff: (
      table: string,
      id: string,
      patch: Record<string, unknown>,
    ) => Promise<QueryRow>,
  ) {}

  query(query: Query): Promise<QueryRow[]> { return this.delegate.query(query); }

  insert(table: string, row: Record<string, unknown>): Promise<QueryRow> {
    return this.delegate.insert(table, row);
  }

  update(table: string, id: string, patch: Record<string, unknown>): Promise<QueryRow> {
    return this.updateWithHandoff(table, id, patch);
  }

  softDelete(table: string, id: string): Promise<void> {
    return this.delegate.softDelete(table, id);
  }

  registryTables(): Promise<RegTable[]> { return this.delegate.registryTables(); }
}
