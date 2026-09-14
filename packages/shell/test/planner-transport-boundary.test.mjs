import { expect, it } from "vitest";
import { assertPlannerTransportModules } from "../config/renderer-runtime.mjs";
const chunk = (runtime, ...ids) => ({ runtime, modules: ids.map(id=>({id,rendered:10})) });
const raw = "packages/mutation/src/raw-client.ts", decoder = "packages/kernel/src/pipeline.ts";
it("requires the raw shell transport and separate closed worker decoder in the real module report", () => {
  expect(()=>assertPlannerTransportModules([chunk("shell",raw),chunk("worker",decoder)],true)).not.toThrow();
  expect(()=>assertPlannerTransportModules([chunk("shell",raw)],true)).toThrow("Missing");
});
it("rejects parser duplication, misplaced provider HTTP and missing capability", () => {
  expect(()=>assertPlannerTransportModules([chunk("shell",raw,"packages/mutation/src/client.ts")])).toThrow("duplicate");
  expect(()=>assertPlannerTransportModules([chunk("shell",raw,decoder)])).toThrow("duplicate");
  expect(()=>assertPlannerTransportModules([chunk("worker",raw)])).toThrow("Provider");
  expect(()=>assertPlannerTransportModules([])).toThrow("Missing");
});
