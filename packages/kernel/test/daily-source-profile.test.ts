import { describe, expect, it } from "vitest";
import type { DailySourceLibraryV1 } from "@clay/schema/daily-home";
import { resolveDailySourceProfiles } from "../src/daily-source-profile";
import type { RegColumn, Registry } from "../src/registry";
import { parseFieldId, parseTableId } from "../src/semantic";

const tableId = parseTableId("tbl_018f4c2a-7b31-7abc-8def-0123456789ab");
const labelId = parseFieldId("fld_018f4c2a-7b31-7abc-8def-0123456789ac");
const dueId = parseFieldId("fld_018f4c2a-7b31-7abc-8def-0123456789ad");
const doneId = parseFieldId("fld_018f4c2a-7b31-7abc-8def-0123456789ae");

function column(
  name: string,
  type: RegColumn["type"],
  fieldId: ReturnType<typeof parseFieldId>,
  extra: Partial<RegColumn> = {},
): RegColumn {
  return {
    name,
    type,
    required: false,
    semantic: {
      v: 1,
      fieldId,
      label: name,
      aliases: [],
      origin: "direct",
      events: [{
        v: 1,
        version: 1,
        operationIndex: 0,
        columnIndex: 0,
        disposition: "introduce",
        origin: "direct",
      }],
    },
    ...extra,
  };
}

function registry(): Registry {
  return new Map([["renamed_tasks", {
    name: "renamed_tasks",
    semantic: {
      v: 1,
      tableId,
      label: "Renamed tasks",
      aliases: ["Tasks"],
      origin: "direct",
      events: [{
        v: 1,
        version: 1,
        operationIndex: 0,
        disposition: "introduce",
        origin: "direct",
      }],
      relationships: [],
    },
    columns: [
      column("renamed_title", "text", labelId),
      column("target_date", "date", dueId),
      column("finished", "boolean", doneId),
    ],
  }]]);
}

function library(completion: DailySourceLibraryV1["profiles"][number]["completion"] = {
  kind: "boolean",
  fieldId: doneId,
  completeValue: true,
}): DailySourceLibraryV1 {
  return {
    schema: 1,
    revision: 4,
    profiles: [{
      schema: 1,
      profileId: `dsp_${"a".repeat(26)}`,
      tableId,
      labelFieldId: labelId,
      dueFieldId: dueId,
      completion,
      enabled: true,
      labelSnapshot: "Tasks",
      dueLabelSnapshot: "Due",
    }],
  };
}

describe("reviewed Daily Home source profiles", () => {
  it("resolves renamed tables and fields only by stable semantic identity", () => {
    expect(resolveDailySourceProfiles(registry(), library())).toEqual({
      ready: [{
        profileId: `dsp_${"a".repeat(26)}`,
        tableId,
        tableName: "renamed_tasks",
        labelFieldId: labelId,
        labelColumnName: "renamed_title",
        dueFieldId: dueId,
        dueColumnName: "target_date",
        completion: {
          kind: "boolean",
          fieldId: doneId,
          columnName: "finished",
          completeValue: true,
        },
      }],
      issues: [],
    });
  });

  it("never falls back to a coincident table or field label", () => {
    const reg = registry();
    const table = reg.get("renamed_tasks")!;
    table.semantic = { ...table.semantic!, tableId: parseTableId("tbl_018f4c2a-7b31-7abc-8def-0123456789af") };
    table.columns[0]!.semantic = {
      ...table.columns[0]!.semantic!,
      fieldId: parseFieldId("fld_018f4c2a-7b31-7abc-8def-0123456789ba"),
      label: "Tasks",
    };

    expect(resolveDailySourceProfiles(reg, library())).toEqual({
      ready: [],
      issues: [{ profileId: `dsp_${"a".repeat(26)}`, reason: "table_missing" }],
    });
  });

  it("marks inactive tables and hidden or inactive bindings as setup issues", () => {
    const inactive = registry();
    inactive.get("renamed_tasks")!.inactive = true;
    expect(resolveDailySourceProfiles(inactive, library()).issues[0]?.reason).toBe("table_inactive");

    const hidden = registry();
    hidden.get("renamed_tasks")!.columns[1]!.hidden = true;
    expect(resolveDailySourceProfiles(hidden, library()).issues[0]?.reason).toBe("due_field_unavailable");

    const retired = registry();
    retired.get("renamed_tasks")!.columns[0]!.inactive = true;
    expect(resolveDailySourceProfiles(retired, library()).issues[0]?.reason).toBe("label_field_unavailable");
  });

  it("requires an active physical date field and compatible completion field", () => {
    const wrongDate = registry();
    wrongDate.get("renamed_tasks")!.columns[1]!.type = "text";
    expect(resolveDailySourceProfiles(wrongDate, library()).issues[0]?.reason).toBe("due_field_not_date");

    const wrongCompletion = registry();
    wrongCompletion.get("renamed_tasks")!.columns[2]!.type = "enum";
    wrongCompletion.get("renamed_tasks")!.columns[2]!.values = ["done"];
    expect(resolveDailySourceProfiles(wrongCompletion, library()).issues[0]?.reason)
      .toBe("completion_field_incompatible");
  });

  it("validates configured enum terminals against the current closed enum", () => {
    const reg = registry();
    reg.get("renamed_tasks")!.columns[2]!.type = "enum";
    reg.get("renamed_tasks")!.columns[2]!.values = ["open", "done", "closed"];
    const completion = {
      kind: "enum" as const,
      fieldId: doneId,
      completeValue: "done",
      terminalValues: ["done", "closed"],
    };
    expect(resolveDailySourceProfiles(reg, library(completion)).ready[0]?.completion).toEqual({
      ...completion,
      columnName: "finished",
    });

    reg.get("renamed_tasks")!.columns[2]!.values = ["open", "done"];
    expect(resolveDailySourceProfiles(reg, library(completion)).issues[0]?.reason)
      .toBe("completion_values_stale");
  });

  it("allows an explicit open-only profile without manufacturing Complete", () => {
    expect(resolveDailySourceProfiles(registry(), library({ kind: "none" })).ready[0]?.completion)
      .toEqual({ kind: "none" });
  });

  it("fails closed on malformed or duplicate profile configuration", () => {
    expect(() => resolveDailySourceProfiles(registry(), {
      ...library(),
      profiles: [{ ...library().profiles[0]!, dueFieldId: "due" }],
    })).toThrow(/invalid/i);
    expect(() => resolveDailySourceProfiles(registry(), {
      ...library(),
      profiles: [library().profiles[0]!, library().profiles[0]!],
    })).toThrow(/invalid/i);
  });
});
