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
    if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
    methods.set(member.name.text, member);
    if (!member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword))
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
        .filter(method => body.includes(`.${method}(`)
          && !body.includes(`mustAuthority().${method}(`));
      if (directStoreWriters.length > 0) {
        expect(
          ["boot", "authority", "authority-store-port", "unavailable"],
          `${name} reaches Store writers ${directStoreWriters.join(", ")} without a fence`,
        ).toContain(classification.enforcement);
      }
      if (classification.enforcement === "boot") {
        expect(body, `${name} must use catalog-first production boot`).toContain("bootProductionAuthority(");
        expect(body).not.toContain("p.appId");
        expect(body).not.toContain("openBrowserDriver(");
      }
      if (classification.enforcement === "authority") {
        const routedThroughAuthority = body.includes(`runAuthorityMutation("${name}"`)
          || (name === "publishBackup" && body.includes("mustAutomaticBackup().publish("))
          || (name === "restoreAsNew" && body.includes("mustRestoreAsNew().restore("));
        expect(routedThroughAuthority, `${name} must use ProductionStoreAuthority`).toBe(true);
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
    expect(driver).toContain("classifyDurableFileInventory(await browserDurableFileNames())");
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

  it("classifies preview discard as unavailable live mutation until attempt finalization is routed", () => {
    const census = DB_WORKER_ROUTE_CENSUS.discard;
    const worker = source("packages/shell/src/worker/db-worker.ts");
    expect(census).toEqual({ enforcement: "unavailable", mutates: "live" });
    const start = worker.indexOf('case "discard"');
    const end = worker.indexOf('case "removeSamples"', start);
    expect(worker.slice(start, end)).toContain("failClosedMutation(req.op)");
    expect(worker.slice(start, end)).not.toContain("dropPending");
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

  it("routes archive export through the bounded production authority read path", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    const authority = source("packages/kernel/src/production-authority.ts");
    const body = caseBody(worker, "exportArchive");
    expect(DB_WORKER_ROUTE_CENSUS.exportArchive)
      .toEqual({ enforcement: "device-trust", mutates: "lifecycle" });
    expect(body).toContain("mustAutomaticBackup().prepareManualDownload()");
    expect(body).not.toContain("store.exportArchive(");
    expect(body).not.toContain("failClosedMutation(");
    expect(authority).toContain('await import("./archive-authority")');
    const authorityModule = ts.createSourceFile(
      "production-authority.ts", authority, ts.ScriptTarget.ESNext, true,
    );
    const archiveImports = authorityModule.statements.filter(
      (statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement)
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === "./archive-authority",
    );
    expect(archiveImports).toHaveLength(1);
    expect(archiveImports[0]?.importClause?.isTypeOnly).toBe(true);
  });

  it("validates authenticated restore bytes and hands the worker to the fresh authority", () => {
    const worker = source("packages/shell/src/worker/db-worker.ts");
    expect(Reflect.get(DB_WORKER_ROUTE_CENSUS, "validateRestoreArchive"))
      .toEqual({ enforcement: "read", mutates: "none" });
    expect(Reflect.get(DB_WORKER_ROUTE_CENSUS, "restoreAsNew"))
      .toEqual({ enforcement: "authority", mutates: "lifecycle" });

    expect(worker).toContain(
      "let restoreAsNew: RestoreAsNewWorkerCoordinator<ProductionRestoredAuthority> | null = null",
    );
    const validateBody = caseBody(worker, "validateRestoreArchive");
    expect(validateBody).toContain("mustRestoreAsNew().validate(");
    expect(validateBody).toContain('transferredBytes(p.bytes, "Restore archive")');
    expect(validateBody).not.toContain("failClosedMutation(");

    const restoreBody = caseBody(worker, "restoreAsNew");
    expect(restoreBody).toContain("mustRestoreAsNew().restore(p.grant)");
    expect(restoreBody).toContain("installRestoredAuthority(");
    expect(restoreBody).not.toContain("failClosedMutation(");
    expect(worker).toContain("authority = restored.authority");
    expect(worker).toContain("store = authority.readStore()");
    expect(worker).toContain("automaticBackup = null");
    expect(worker).toContain("restoreAsNew = null");
    expect(worker).toContain("previous.close()");
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
    expect(caseBody(worker, "removeSamples")).not.toContain("req.payload");
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