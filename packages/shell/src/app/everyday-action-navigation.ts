import type { EverydayActionTarget } from "../worker/first-success-journey";

export type EverydayTargetClient = {
  firstEverydayActionTarget(): Promise<EverydayActionTarget | null>;
};

/** Resolves the worker-selected real record before changing UI state, so the
 * checklist cannot send the person to an unrelated generic workspace. */
export async function openEverydayActionTarget(
  client: EverydayTargetClient,
  openRecord: (table: string, rowId: string) => void,
): Promise<EverydayActionTarget> {
  const target = await client.firstEverydayActionTarget();
  if (!target)
    throw new Error("Add a real record before doing an everyday action");
  openRecord(target.table, target.rowId);
  return target;
}
