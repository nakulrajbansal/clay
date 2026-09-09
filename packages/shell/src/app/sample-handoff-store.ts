import type {
  AsyncStore, Query, QueryRow, RegTable, StoreMutationContext,
} from "@clay/kernel";

/** Routes live record edits through the worker-owned atomic sample-to-real
 * handoff while preserving the ordinary Store RPC for every other operation. */
export class SampleHandoffStore implements AsyncStore {
  constructor(
    private readonly delegate: AsyncStore,
    private readonly updateWithHandoff: (
      table: string,
      id: string,
      patch: Record<string, unknown>,
      context: StoreMutationContext,
    ) => Promise<QueryRow>,
  ) {}

  query(query: Query): Promise<QueryRow[]> { return this.delegate.query(query); }

  insert(
    table: string, row: Record<string, unknown>, context: StoreMutationContext,
  ): Promise<QueryRow> {
    return this.delegate.insert(table, row, context);
  }

  update(
    table: string, id: string, patch: Record<string, unknown>, context: StoreMutationContext,
  ): Promise<QueryRow> {
    return this.updateWithHandoff(table, id, patch, context);
  }

  softDelete(table: string, id: string, context: StoreMutationContext): Promise<void> {
    return this.delegate.softDelete(table, id, context);
  }

  registryTables(): Promise<RegTable[]> { return this.delegate.registryTables(); }
}
