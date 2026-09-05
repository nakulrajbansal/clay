import { describe, expect, it } from "vitest";
import { classifyDurableFileInventory } from "../src/durable-inventory";

describe("authoritative durable file inventory", () => {
  it("recognizes exact zero inventory and complete legacy/current namespace pairs", () => {
    expect(classifyDurableFileInventory([])).toEqual({
      state: "complete", catalogPresent: false, namespaces: [],
    });
    expect(classifyDurableFileInventory(["/user.db", "/system.db"])).toEqual({
      state: "complete",
      catalogPresent: false,
      namespaces: [{
        storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy",
      }],
    });
    expect(classifyDurableFileInventory([
      "/clay-device-catalog-v1.db",
      "/app-customer_ops-user.db",
      "/app-customer_ops-system.db",
      `/ns_${"a".repeat(26)}-user.db`,
      `/ns_${"a".repeat(26)}-system.db`,
    ])).toEqual({
      state: "complete",
      catalogPresent: true,
      namespaces: [
        {
          storageKey: "customer_ops",
          userFile: "/app-customer_ops-user.db",
          systemFile: "/app-customer_ops-system.db",
          kind: "legacy",
        },
        {
          storageKey: `ns_${"a".repeat(26)}`,
          userFile: `/ns_${"a".repeat(26)}-user.db`,
          systemFile: `/ns_${"a".repeat(26)}-system.db`,
          kind: "generation",
        },
      ],
    });
  });

  it.each([
    [["/user.db"], "orphan_namespace"],
    [["/system.db"], "orphan_namespace"],
    [["/user.db", "/system.db", "/user.db"], "duplicate_file"],
    [["/clay-device-catalog-v1.db", "/clay-device-catalog-v1.db"], "duplicate_file"],
    [["/user.db-journal"], "pending_sqlite_file"],
    [["/mystery.db"], "unknown_file"],
    [["/app-../escape-user.db", "/app-../escape-system.db"], "unknown_file"],
    [[`/ns_${"1".repeat(26)}-user.db`, `/ns_${"1".repeat(26)}-system.db`], "unknown_file"],
  ] as const)("fails closed for ambiguous inventory %j", (files, reason) => {
    expect(classifyDurableFileInventory([...files])).toEqual({ state: "ambiguous", reason });
  });

  it("sorts the returned namespace projection deterministically", () => {
    const result = classifyDurableFileInventory([
      "/app-zed-system.db", "/app-alpha-user.db", "/app-zed-user.db", "/app-alpha-system.db",
    ]);
    expect(result.state).toBe("complete");
    if (result.state === "complete")
      expect(result.namespaces.map(item => item.storageKey)).toEqual(["alpha", "zed"]);
  });
});
