import { expect, it } from "vitest";
import { upsertReviewedDailySource, resetDailySourceLibrary, type DailySourceProfileStorage } from "../src/daily-source-profile";
import { toggleDailyFavorite, type DailyNavigationStorage } from "../src/daily-navigation";
const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
const labelFieldId = "fld_018f4c2a-7b31-7001-8000-000000000002";
const dueFieldId = "fld_018f4c2a-7b31-7001-8000-000000000003";
const otherDue = "fld_018f4c2a-7b31-7001-8000-000000000004";
it("does not overwrite another window's changed binding after a source CAS loss", async () => {
  let writes = 0;
  const storage: DailySourceProfileStorage = { getSetting: async () => null,
    compareAndSetDailySource: async (_revision, value) => {
      writes++; const candidate = value as { profiles: Array<Record<string, unknown>>; revision: number };
      return { ok: false, current: { ...candidate, profiles: candidate.profiles.map(profile => ({ ...profile, dueFieldId: otherDue })) } };
    } };
  await expect(upsertReviewedDailySource(storage, { tableId, labelFieldId, dueFieldId, completion: { kind: "none" } })).rejects.toThrow(/review|changed/);
  expect(writes).toBe(1);
});
it("does not erase newly configured sources when a reset loses its CAS", async () => {
  let writes = 0;
  const storage: DailySourceProfileStorage = { getSetting: async () => null,
    compareAndSetDailySource: async () => { writes++; return { ok: false, current: { schema: 1, revision: writes, profiles: [] } }; } };
  await expect(resetDailySourceLibrary(storage)).rejects.toThrow(/changed/);
  expect(writes).toBe(1);
});
it("keeps the user's initial pin intent when another window pins the same record first", async () => {
  const reference = { tableId, rowId: "018f4c2a-7b31-7001-8000-000000000011" };
  let writes = 0;
  const storage: DailyNavigationStorage = { getSetting: async () => null,
    compareAndSetDailyNavigation: async (_revision, value) => {
      if (++writes === 1) return { ok: false, current: value };
      return { ok: true, current: value };
    } };
  const result = await toggleDailyFavorite(storage, reference, () => "2026-09-13T00:00:00.000Z");
  expect(result.favorite).toBe(true);
  expect(result.state.favorites).toHaveLength(1);
});
