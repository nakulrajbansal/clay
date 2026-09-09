import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const app = fs.readFileSync(path.resolve(import.meta.dirname, "../src/app/App.tsx"), "utf8");
const budget = fs.readFileSync(path.resolve(import.meta.dirname, "../../../scripts/bundle-budget.mjs"), "utf8");

describe("backup runtime entry boundary", () => {
  it("keeps backup adapters and scheduler out of the static owner entry", () => {
    expect(app).not.toMatch(/^import (?!type\b)[^;]+from "\.\/production-backup\.browser";/m);
    expect(app).not.toMatch(/^import (?!type\b)[^;]+from "\.\/automatic-backup-trigger\.browser";/m);
    expect(app).toContain('import("./production-backup.browser")');
    expect(app).toContain('import("./automatic-backup-trigger.browser")');
    expect(app).toContain("loadAutomaticBackupTriggerRuntime");
    expect(app).toContain("retryAutomaticBackupRuntime();");
    expect(app).toContain('recordBackupFailure("operation_interrupted")');
    expect(app).toContain("retryAutomaticBackupRuntime, attempt * 2_000");
    expect(app).toContain("currentIdRef.current !== appId");
    expect(app).not.toContain(
      '() => { setBackupAdapterAvailable(false); }',
    );
    expect(app).not.toMatch(
      /^import (?!type\b)[^;]*MAX_BACKUP_ARCHIVE_BYTES[^;]*from "@clay\/kernel\/backup";/m,
    );
    expect(budget).toContain(
      '{ label: "ProductionBackupRuntime", source: "src/app/production-backup.browser.ts" }',
    );
    expect(budget).toContain(
      '{ label: "AutomaticBackupTrigger", source: "src/app/automatic-backup-trigger.browser.ts" }',
    );
  });
});
