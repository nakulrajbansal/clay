import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_WRITE_ROUTE_CENSUS,
  CLAY_STORE_WRITER_CENSUS,
  DB_WORKER_ROUTE_CENSUS,
  STORE_RPC_ROUTE_CENSUS,
} from "../src/worker/mutation-route-census";

const shellRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(shellRoot, "../..");
const source = (relative: string): string =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8");

function quotedSwitchCases(text: string): Set<string> {
  return new Set([...text.matchAll(/\bcase\s+"([^"]+)"\s*:/g)].map(match => match[1]!));
}

function caseBody(text: string, route: string): string {
  const marker = `case "${route}"`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const nextCase = text.indexOf("case \"", start + marker.length);
  const nextDefault = text.indexOf("default:", start + marker.length);
  const candidates = [nextCase, nextDefault].filter(index => index >= 0);
  return text.slice(start, candidates.length > 0 ? Math.min(...candidates) : text.length);
}

function clayStorePublicWriterNames(text: string): Set<string> {
  const file = ts.createSourceFile("store.ts", text, ts.ScriptTarget.ESNext, true);
  const clayStore = file.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === "ClayStore");
  if (!clayStore) throw new Error("ClayStore class is missing");

  const methods = new Map<string, ts.MethodDeclaration>();
  const publicMethods = new Set<string>();
  for (const member of clayStore.members) {
    if (!ts.isMethodDeclaration(member) || !member.body
        || (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name))) continue;
    methods.set(member.name.text, member);
    if (ts.isIdentifier(member.name)
        && !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword))
      publicMethods.add(member.name.text);
  }

  const writerNames = new Set<string>();
  const directExternalWriters = new Set([
    "record", "setCollectionEnabled", "clear", "markShown", "dismiss", "accept",
    "copyDatabase",
  ]);
  const calls = new Map<string, Set<string>>();
  for (const [name, method] of methods) {
    const localCalls = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isPropertyAccessExpression(expression)) {
          const called = expression.name.text;
          if (called === "exec" || called === "tx" || directExternalWriters.has(called))
            writerNames.add(name);
          if (called === "call" && ts.isPropertyAccessExpression(expression.expression)
              && ts.isIdentifier(expression.expression.expression)
              && expression.expression.expression.text === "PRODUCTION_STORE_PRIMITIVES")
            localCalls.add(expression.expression.name.text);
          if (expression.expression.kind === ts.SyntaxKind.ThisKeyword
              || (ts.isIdentifier(expression.expression)
                && expression.expression.text === "ClayStore")) localCalls.add(called);
        } else if (ts.isIdentifier(expression) && directExternalWriters.has(expression.text)) {
          writerNames.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(method.body!);
    calls.set(name, localCalls);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, localCalls] of calls) {
      if (writerNames.has(name)) continue;
      if ([...localCalls].some(called => writerNames.has(called))) {
        writerNames.add(name);
        changed = true;
      }
    }
  }
  return new Set([...writerNames].filter(name => publicMethods.has(name)));
}

describe("production mutation route census", () => {
  it("classifies every db-worker command and enforces every live writer", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    expect([...quotedSwitchCases(worker)].sort())
      .toEqual(Object.keys(DB_WORKER_ROUTE_CENSUS).sort());

    expect(worker).toContain("enforceProductionMutationRoute(req.op)");
    for (const [name, classification] of Object.entries(DB_WORKER_ROUTE_CENSUS)) {
      const body = caseBody(worker, name);
      const directStoreWriters = Object.keys(CLAY_STORE_WRITER_CENSUS)
        .filter(method => body.includes(`.${method}(`));
      if (directStoreWriters.length > 0) {
        expect(
          ["boot", "authority", "planner-authority", "authority-store-port", "unavailable"],
          `${name} reaches Store writers ${directStoreWriters.join(", ")} without a fence`,
        ).toContain(classification.enforcement);
      }
      if (classification.enforcement === "boot") {
        expect(body, `${name} must use catalog-first production boot`).toContain("bootProductionAuthority(");
        expect(body).not.toContain("p.appId");
        expect(body).not.toContain("openBrowserDriver(");
      }
      if (classification.enforcement === "authority")
        expect(body, `${name} must use ProductionStoreAuthority`).toContain(`runAuthorityMutation("${name}"`);
      if (classification.enforcement === "planner-authority") {
        const expected = name === "keep" ? "keepPendingPreview("
          : name === "discard" ? "discardPendingPreview(" : "runPipelineText(";
        expect(body, `${name} must use bounded planner authority`).toContain(expected);
        expect(body).not.toContain("failClosedMutation(");
      }
      if (classification.enforcement === "authority-store-port")
        expect(body, `${name} must serve the authority adapter`).toContain("serveProductionStore(");
    }
  });

  it("classifies every public ClayStore writer", () => {
    const store = source("packages/kernel/src/store.ts");
    expect([...clayStorePublicWriterNames(store)].sort())
      .toEqual(Object.keys(CLAY_STORE_WRITER_CENSUS).sort());
  });

  it("keeps browser selection on trusted inventory and authority behind a declared worker entry", () => {
    const driver = source("packages/kernel/src/db.ts");
    const guard = source("packages/kernel/src/live-write-guard.ts");
    const authority = source("packages/kernel/src/production-authority.ts");
    const publicIndex = source("packages/kernel/src/index.ts");
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const kernelPackage = JSON.parse(source("packages/kernel/package.json")) as {
      exports: Record<string, string>;
    };
    expect(driver).toContain("pool.getFileNames()");
    expect(driver).toContain("classifyDurableFileInventory(names)");
    expect(driver).toContain("AS sys");
    expect(driver).toContain("AS catalog");
    expect(guard).toContain("export function createLiveWriteGuard");
    expect(guard).not.toContain("export class LiveWriteGuard");
    expect(authority.indexOf("browserDurableInventory()"))
      .toBeLessThan(authority.indexOf("openBrowserProductionTarget(namespace)"));
    expect(authority).toContain("let selected = catalog.selectedTargetStorage()");
    expect(authority).toContain("selected.storageKey");
    expect(publicIndex).not.toContain("ProductionStoreAuthority");
    expect(publicIndex).not.toContain("ProductionMutationCoordinator");
    expect(kernelPackage.exports["./worker-authority"])
      .toBe("./src/worker-authority.ts");
    expect(worker).toContain('from "@clay/kernel/worker-authority"');
    expect(worker).toContain('await import("@clay/kernel/worker-authority")');
    expect(worker).toContain("import type {");
    expect(worker).toContain("let store: ProductionStoreReader | null = null");
    expect(worker).toContain("store = authority.readStore()");
    expect(worker).toContain("return bootProductionAuthority(p)");
    expect(authority).toContain("static async bootBrowser(input");
    expect(authority).toContain("captureBrowserBootInput(input)");
    expect(worker).not.toContain("authority.store");
    expect(worker).not.toContain("let store: ClayStore");
    expect(worker).not.toMatch(/from ["'][.]{2}[/\\][.]{2}[/\\][.]{2}[/\\]kernel[/\\]src[/\\]/);
  });

  it("routes checkpoint labels through the production authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "setCheckpoint");
    expect(DB_WORKER_ROUTE_CENSUS.setCheckpoint)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(CLAY_STORE_WRITER_CENSUS.setCheckpoint).toBe("authority");
    expect(body).toContain('runAuthorityMutation("setCheckpoint"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "timeline.setCheckpoint"');
  });

  it("routes make-latest through the production authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "makeLatest");
    expect(DB_WORKER_ROUTE_CENSUS.makeLatest)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(CLAY_STORE_WRITER_CENSUS.rollbackTo).toBe("unavailable");
    expect(body).toContain('runAuthorityMutation("makeLatest"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "timeline.makeLatest"');
  });

  it("routes panel revert through the production authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "revertPanel");
    expect(DB_WORKER_ROUTE_CENSUS.revertPanel)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(CLAY_STORE_WRITER_CENSUS.revertPanel).toBe("authority");
    expect(body).toContain('runAuthorityMutation("revertPanel"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "panel.revert"');
  });

  it("routes panel rename through the production authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "renamePanel");
    expect(DB_WORKER_ROUTE_CENSUS.renamePanel)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(CLAY_STORE_WRITER_CENSUS.renamePanel).toBe("authority");
    expect(body).toContain('runAuthorityMutation("renamePanel"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "panel.rename"');
  });

  it("routes panel removal through the production authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "removePanel");
    expect(DB_WORKER_ROUTE_CENSUS.removePanel)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(CLAY_STORE_WRITER_CENSUS.removePanel).toBe("authority");
    expect(body).toContain('runAuthorityMutation("removePanel"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "panel.remove"');
  });

  it("routes non-relation column creation through the production authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "addColumn");
    expect(DB_WORKER_ROUTE_CENSUS.addColumn)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(CLAY_STORE_WRITER_CENSUS.commit).toBe("unavailable");
    expect(body).toContain('runAuthorityMutation("addColumn"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "schema.addColumn"');
    expect(worker).not.toContain("addColumnCommit(");
  });

  it("routes column rename through the production authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "renameColumn");
    expect(DB_WORKER_ROUTE_CENSUS.renameColumn)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(body).toContain('runAuthorityMutation("renameColumn"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "schema.renameColumn"');
    expect(worker).not.toContain("renameColumnCommit(");
  });

  it("routes relation-column creation through its explicit production-authority command", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const dataView = source("packages/shell/src/app/DataView.tsx");
    const body = caseBody(worker, "addRelationColumn");
    expect(DB_WORKER_ROUTE_CENSUS.addRelationColumn)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(body).toContain('runAuthorityMutation("addRelationColumn"');
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "schema.addRelationColumn"');
    expect(dataView).toContain("worker.addRelationColumn(selected, column as never)");
  });

  it("routes preview discard through durable authority and closes shadow separately", () => {
    const census = DB_WORKER_ROUTE_CENSUS.discard;
    const worker = source("packages/shell/src/worker/db-worker.ts");
    expect(census).toEqual({ enforcement: "planner-authority", mutates: "live" });
    const start = worker.indexOf('case "discard"');
    const end = worker.indexOf('case "removeSamples"', start);
    expect(worker.slice(start, end)).toContain("discardPendingPreview(req)");
    expect(worker).toContain("await planner.discard(requestId, current.preview.command)");
    expect(worker).toContain("current.preview.shadow.close()");
    const discardHelper = worker.slice(worker.indexOf("async function discardPendingPreview"),
      worker.indexOf("function serveProductionStore"));
    expect(discardHelper.indexOf("await planner.discard(requestId, current.preview.command)"))
      .toBeLessThan(discardHelper.indexOf("current.preview.shadow.close()"));
  });

  it("keeps a failed durable Discard retryable with the prepared command and shadow", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const discardHelper = worker.slice(worker.indexOf("async function discardPendingPreview"),
      worker.indexOf("function serveProductionStore"));
    expect(discardHelper).toContain("} catch (error) {");
    expect(discardHelper).toContain('if (pending === current) current.decision = "open"');
    expect(discardHelper).not.toContain("} finally {");
    expect(discardHelper.indexOf("await planner.discard(requestId, current.preview.command)"))
      .toBeLessThan(discardHelper.indexOf("current.preview.shadow.close()"));
  });

  it("keeps the UI protocol while removing raw preview and live Store capabilities", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    expect(worker).not.toContain("PreviewHandle");
    expect(worker).not.toContain("InProcessAsyncStore");
    expect(worker).not.toContain("let store: ClayStore");
    expect(worker).toContain("PreparedMutationPreview");
    expect(worker).toContain("plannerMutations()");
    expect(worker).toContain('import("@clay/kernel/planner-pipeline")');
    expect(worker).toContain('import("@clay/mutation/client")');
    expect(worker).toContain("summary: result.preview.plan.summary");
    expect(worker).toContain("return { version }");
    expect(worker).toContain("return null");
  });

  it("routes starter seed through a static bundle with the stable worker request identity", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const body = caseBody(worker, "seed");
    expect(DB_WORKER_ROUTE_CENSUS.seed)
      .toEqual({ enforcement: "authority", mutates: "live" });
    expect(body).toContain("createStarterSeedBundle(p.shellId)");
    expect(body).toContain('runAuthorityMutation("seed"');
    expect(body).not.toContain("seedStarterShell(");
    expect(body).not.toContain("failClosedMutation(");
    expect(worker).toContain('route: "starter.seed"');
    expect(worker).toContain("const requestId = authorityRequestId(req)");
  });

  it("routes data lifecycle commands through authority without an ambient Store", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const routes = [
      "addAttachment", "removeAttachment", "purgeDeletedAttachments",
      "applyBatch", "undoBatch", "restoreRow", "removeColumn",
    ] as const;
    for (const name of routes) {
      expect(DB_WORKER_ROUTE_CENSUS[name])
        .toEqual({ enforcement: "authority", mutates: "live" });
      const body = caseBody(worker, name);
      expect(body, name).toContain(`runAuthorityMutation("${name}"`);
      expect(body, name).not.toContain("failClosedMutation(");
      expect(body, name).not.toContain("mustStore()");
    }
    expect(worker).toContain('route: "attachment.add"');
    expect(worker).toContain('route: "attachment.remove"');
    expect(worker).toContain('route: "attachment.purge"');
    expect(worker).toContain('route: "batch.apply"');
    expect(worker).toContain('route: "batch.undo"');
    expect(worker).toContain('route: "row.restore"');
    expect(worker).toContain('route: "schema.removeColumn"');
  });

  it("authority-routes automation, notification, observer, and operational metrics", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const workerRoutes = [
      "upsertAutomation", "deleteAutomation", "runAutomations", "runAutomationNow",
      "undoAutomationRun", "markNotificationRead", "recordPrivateMetric",
      "setPrivateMetricsEnabled", "clearPrivateMetrics", "recordFilter",
      "acceptSuggestion", "dismissSuggestion",
    ] as const;
    for (const route of workerRoutes) {
      expect(DB_WORKER_ROUTE_CENSUS[route], route)
        .toEqual({ enforcement: "authority", mutates: "live" });
      expect(caseBody(worker, route), route).toContain(`runAuthorityMutation("${route}"`);
      expect(caseBody(worker, route), route).not.toContain("failClosedMutation(");
    }
    expect(DB_WORKER_ROUTE_CENSUS.simulateAutomation)
      .toEqual({ enforcement: "read", mutates: "none" });
    expect(caseBody(worker, "simulateAutomation")).toContain("mustStore().simulateAutomation(");
    expect(worker).toContain("target.executeOperationalMetricMutation(");
    expect(worker).toContain('route: "runDueAutomations"');
    expect(worker).toContain('route: "recordUsage"');
    expect(worker).not.toContain("mustStore().recordPrivateMetric(");
    expect(CLAY_STORE_WRITER_CENSUS).toMatchObject({
      upsertAutomation: "authority",
      deleteAutomation: "authority",
      runAutomationNow: "authority",
      runDueAutomations: "authority",
      undoAutomationRun: "authority",
      markNotificationRead: "authority",
      recordPrivateMetric: "authority",
      setPrivateMetricsEnabled: "authority",
      clearPrivateMetrics: "authority",
      recordUsage: "authority",
      acceptSuggestion: "authority",
      dismissSuggestion: "authority",
    });
  });

  it("routes import and sample operations through captured authority commands", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    for (const name of ["importTable", "removeSamples", "fillSamples"] as const) {
      expect(DB_WORKER_ROUTE_CENSUS[name]).toEqual({
        enforcement: "authority",
        mutates: "live",
      });
      const body = caseBody(worker, name);
      expect(body).toContain(`runAuthorityMutation("${name}"`);
      expect(body).not.toContain("failClosedMutation(");
    }
    expect(worker).toContain('route: "table.import"');
    expect(worker).toContain('route: "samples.remove"');
    expect(worker).toContain('route: "samples.fill"');
    expect(caseBody(worker, "removeSamples"))
      .toContain('runAuthorityMutation("removeSamples", p, req)');
    expect(worker.slice(
      worker.indexOf('if (route === "removeSamples")'),
      worker.indexOf('if (route === "fillSamples")'),
    )).toContain("payload,");
    expect(caseBody(worker, "fillSamples")).toContain("createSampleFillBundle(mustStore())");
    expect(caseBody(worker, "sampleCount")).toContain("mustAuthority().sampleRowCount()");
    expect(worker).not.toContain("fillSampleRows(mustStore())");
    expect(worker).not.toContain("removeSampleRows(mustStore())");
  });

  it("keeps StoreRpc and Bridge writes on the authority-backed port", () => {
    const rpc = source("packages/kernel/src/asyncstore.ts");
    const bridge = source("packages/kernel/src/bridge.ts");
    expect([...quotedSwitchCases(rpc)].sort())
      .toEqual(Object.keys(STORE_RPC_ROUTE_CENSUS).sort());
    expect([...quotedSwitchCases(bridge)].filter(name => name.startsWith("db.")).sort())
      .toEqual(Object.keys(BRIDGE_WRITE_ROUTE_CENSUS).sort());
    expect(rpc).toContain("serveStore(store: AsyncStore");
    expect(rpc).not.toContain("new InProcessAsyncStore(store)");
    expect(caseBody(source("packages/shell/src/worker/db-worker.ts"), "storePort"))
      .toContain("serveProductionStore(");
  });
});