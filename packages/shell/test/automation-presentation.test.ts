import { expect, it } from "vitest";
import { editableAutomation, readAutomationWorkspace, writeAutomationWorkspace } from "../src/app/automation-presentation";
import type { AutomationDefinitionV2 } from "@clay/kernel";

it("edits V2 metadata without dropping additional conditions, actions, value sources, recipe or timezone", () => {
  const definition = { v: 2, id: "auto_018f0000000070008000000000000001", name: "Original",
    recipe: { id: "weekly_checklist", version: 1 }, trigger: { kind: "schedule", cadence: "daily", localTime: "09:00" },
    actions: [{ kind: "notify", title: "First", body: "First" }, { kind: "notify", title: "Second", body: "Second" }],
    runtime: { mode: "local", timeZone: "Pacific/Auckland", missedPolicy: "skip" }, enabled: true,
    definitionRevision: 8, authorityTarget: null } as unknown as AutomationDefinitionV2;
  const edit = editableAutomation(definition); edit.name = "Edited";
  expect(edit.actions).toEqual(definition.actions); expect(edit.runtime).toEqual(definition.runtime);
  expect(edit.recipe).toEqual(definition.recipe); expect(edit).not.toHaveProperty("enabled");
  expect(edit).not.toHaveProperty("definitionRevision"); expect(definition.name).toBe("Original");
});

it("retains a draft's original app, generation, reviewed source and identity across reload", () => {
  const rows = new Map<string, string>(); const cache = { getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const target = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`,
    lineageEpoch: "1", protectionRevision: "4", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const workspace = { schema: 1 as const, draftId: `req_${"d".repeat(26)}`, authorityTarget: target,
    kind: "custom" as const, fields: { name: "Recurring", timeZone: "Pacific/Auckland" }, definition: null, expectedRevision: null, recipeId: null };
  writeAutomationWorkspace(cache, workspace);
  expect(readAutomationWorkspace(cache, target.appInstanceId)).toEqual(workspace);
  expect(readAutomationWorkspace(cache, `app_${"z".repeat(26)}`)).toBeNull();
  expect(() => writeAutomationWorkspace(cache, { ...workspace, draftId: `req_${"e".repeat(26)}` })).toThrow(/identity/);
  expect(readAutomationWorkspace(cache, target.appInstanceId)?.draftId).toBe(workspace.draftId);
});
