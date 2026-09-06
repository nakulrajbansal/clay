import type { MutationPlan } from "@clay/schema";
import { InProcessAsyncStore, type AsyncStore } from "./asyncstore";
import { ClayError } from "./errors";
import {
  buildPreparedMutationCommand,
  capturePreparedPreviewInput,
  capturePreparedMutationCommand,
  materializePreparedSemanticAssignments,
  type PreparedMutationBase,
  type PreparedMutationCommand,
  type PreparedPreviewInput,
} from "./planner-command";
import type { Registry } from "./registry";
import { sha256HexSync } from "./state-digest";
import {
  ClayStore,
  type LivePanel,
  type PanelBlobInput,
} from "./store";

export type PreviewShadow = Readonly<{
  query: ClayStore["query"];
  semanticSchemaTrace: ClayStore["semanticSchemaTrace"];
  asyncStore(): AsyncStore;
  close(): void;
}>;

export type PreparedMutationPreview = Readonly<{
  command: PreparedMutationCommand;
  plan: MutationPlan;
  shadow: PreviewShadow;
  version: number;
}>;

export type PlanningCapture = Readonly<{
  base: PreparedMutationBase;
  registry: Registry;
  validationRegistry: Registry;
  livePanels: readonly LivePanel[];
  recentSummaries: readonly string[];
}>;

export type PlannerMutationAuthority = Readonly<{
  beginAttempt(intent: string): Promise<string>;
  capturePlanningBase(): PlanningCapture;
  preparePreview(input: PreparedPreviewInput): Promise<PreparedMutationPreview>;
  assertPlanningBase(base: PreparedMutationBase): void;
  finalizeAttempt(
    attemptId: string,
    outcome: "clarify" | "failed",
    errorCode?: string,
  ): Promise<void>;
  keep(requestId: string, command: unknown): Promise<number>;
  discard(requestId: string, command: unknown): Promise<void>;
}>;

function toCommitPanels(plan: MutationPlan): PanelBlobInput[] {
  return plan.panels.map(panel => ({
    panel_id: panel.panel_id,
    title: panel.title,
    placement: panel.placement,
    code: panel.code,
    declared_queries: panel.declared_queries,
    declared_writes: panel.declared_writes,
  }));
}

const STORE_HEAD_VERSION: ClayStore["headVersion"] = ClayStore.prototype.headVersion;
const STORE_REGISTRY: ClayStore["registrySnapshot"] = ClayStore.prototype.registrySnapshot;
const STORE_VALIDATION_REGISTRY: ClayStore["validationRegistrySnapshot"] =
  ClayStore.prototype.validationRegistrySnapshot;
const STORE_LIVE_PANELS: ClayStore["livePanels"] = ClayStore.prototype.livePanels;
const STORE_RECENT_SUMMARIES: ClayStore["recentSummaries"] = ClayStore.prototype.recentSummaries;
const STORE_PREPARE_SEMANTICS: ClayStore["prepareSemanticAssignments"] =
  ClayStore.prototype.prepareSemanticAssignments;
const STORE_SHADOW_COPY: ClayStore["shadowCopy"] = ClayStore.prototype.shadowCopy;
const STORE_COMMIT: ClayStore["commit"] = ClayStore.prototype.commit;
const STORE_COMMIT_PREPARED: ClayStore["commitPreparedMutation"] =
  ClayStore.prototype.commitPreparedMutation;
const STORE_BEGIN_ATTEMPT: ClayStore["beginAttempt"] = ClayStore.prototype.beginAttempt;
const STORE_FINISH_ATTEMPT: ClayStore["finishAttempt"] = ClayStore.prototype.finishAttempt;
const STORE_QUERY: ClayStore["query"] = ClayStore.prototype.query;
const STORE_SEMANTIC_TRACE: ClayStore["semanticSchemaTrace"] =
  ClayStore.prototype.semanticSchemaTrace;
const STORE_CLOSE: ClayStore["close"] = ClayStore.prototype.close;

export function capturePlannerMutationBase(store: ClayStore): PreparedMutationBase {
  const version = STORE_HEAD_VERSION.call(store);
  const registry = [...STORE_VALIDATION_REGISTRY.call(store).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  const panels = STORE_LIVE_PANELS.call(store)
    .sort((left, right) => left.panel_id.localeCompare(right.panel_id));
  const encoded = new TextEncoder().encode(JSON.stringify({ version, registry, panels }));
  return Object.freeze({
    version,
    shapeSha256: `sha256:${sha256HexSync(encoded)}`,
  });
}

function sameBase(left: PreparedMutationBase, right: PreparedMutationBase): boolean {
  return left.version === right.version && left.shapeSha256 === right.shapeSha256;
}

export function assertPlannerMutationBase(
  store: ClayStore,
  expected: PreparedMutationBase,
): void {
  if (!sameBase(capturePlannerMutationBase(store), expected))
    throw new ClayError("E_CONFLICT",
      "App changed while this preview was open or being prepared. Reshape again from the latest version.");
}

function previewShadow(store: ClayStore): PreviewShadow {
  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new ClayError("E_CONFLICT", "preview shadow is closed");
  };
  const shadow: PreviewShadow = {
    query: (...args) => {
      ensureOpen();
      return STORE_QUERY.apply(store, args);
    },
    semanticSchemaTrace: (...args) => {
      ensureOpen();
      return STORE_SEMANTIC_TRACE.apply(store, args);
    },
    asyncStore: () => {
      ensureOpen();
      return new InProcessAsyncStore(store);
    },
    close: () => {
      if (closed) return;
      closed = true;
      STORE_CLOSE.call(store);
    },
  };
  return Object.freeze(shadow);
}

export type PlannerAuthorityWrites = Readonly<{
  beginAttempt(intent: string): Promise<string>;
  finalizeAttempt(
    attemptId: string,
    outcome: "clarify" | "failed" | "discarded",
    errorCode?: string,
  ): Promise<void>;
  keep(requestId: string, command: unknown): Promise<number>;
  discard(requestId: string, command: unknown): Promise<void>;
}>;

/** Build the narrow planner boundary around an authority-owned Store. */
export function createStoreBackedPlannerMutationAuthority(
  store: ClayStore,
  writes: PlannerAuthorityWrites,
): PlannerMutationAuthority {
  const capturePlanningBase = (): PlanningCapture => Object.freeze({
    base: capturePlannerMutationBase(store),
    registry: STORE_REGISTRY.call(store),
    validationRegistry: STORE_VALIDATION_REGISTRY.call(store),
    livePanels: Object.freeze(STORE_LIVE_PANELS.call(store)),
    recentSummaries: Object.freeze(STORE_RECENT_SUMMARIES.call(store, 5)),
  });
  const authority: PlannerMutationAuthority = {
    beginAttempt: writes.beginAttempt,
    capturePlanningBase,
    assertPlanningBase: base => assertPlannerMutationBase(store, base),
    finalizeAttempt: (attemptId, outcome, errorCode) =>
      writes.finalizeAttempt(attemptId, outcome, errorCode),
    preparePreview: async rawInput => {
      const input = capturePreparedPreviewInput(rawInput);
      assertPlannerMutationBase(store, input.base);
      const plan = input.plan;
      const semanticAssignments = STORE_PREPARE_SEMANTICS.call(store, plan.migration, "model");
      const shadowStore = await STORE_SHADOW_COPY.call(store);
      try {
        assertPlannerMutationBase(shadowStore, input.base);
        STORE_COMMIT.call(shadowStore, {
          intent: input.intent,
          summary: plan.summary,
          migration: plan.migration,
          semanticOrigin: "model",
          semanticAssignments,
          panels: toCommitPanels(plan),
          removePanels: plan.remove_panels,
          diff: plan.user_facing_diff,
        });
        assertPlannerMutationBase(store, input.base);
        const command = buildPreparedMutationCommand({
          attemptId: input.attemptId,
          base: input.base,
          intent: input.intent,
          plan,
          semanticAssignments,
        });
        return Object.freeze({
          command,
          plan: command.plan,
          shadow: previewShadow(shadowStore),
          version: input.base.version + 1,
        });
      } catch (error) {
        STORE_CLOSE.call(shadowStore);
        throw error;
      }
    },
    keep: writes.keep,
    discard: writes.discard,
  };
  return Object.freeze(authority);
}

/** Execute captured prepared data. Production calls this only from its
 * synchronous physical publication transaction. */
export function executePreparedPlannerKeep(
  store: ClayStore,
  command: PreparedMutationCommand,
): number {
  assertPlannerMutationBase(store, command.base);
  const semanticAssignments = materializePreparedSemanticAssignments(
    STORE_PREPARE_SEMANTICS.call(store, command.plan.migration, "model"),
    command.semanticAssignments,
  );
  return STORE_COMMIT_PREPARED.call(store, {
    intent: command.intent,
    summary: command.plan.summary,
    migration: command.plan.migration,
    semanticOrigin: "model",
    semanticAssignments,
    panels: toCommitPanels(command.plan),
    removePanels: command.plan.remove_panels,
    diff: command.plan.user_facing_diff,
  }, command.attemptId);
}

export function createInProcessPlannerMutationAuthority(
  store: ClayStore,
): PlannerMutationAuthority {
  return createStoreBackedPlannerMutationAuthority(store, {
    beginAttempt: async intent => STORE_BEGIN_ATTEMPT.call(store, intent),
    finalizeAttempt: async (attemptId, outcome, errorCode) =>
      STORE_FINISH_ATTEMPT.call(store, attemptId, outcome, errorCode ?? null),
    keep: async (_requestId, command) =>
      executePreparedPlannerKeep(store, capturePreparedMutationCommand(command)),
    discard: async (_requestId, command) => {
      const captured = capturePreparedMutationCommand(command);
      STORE_FINISH_ATTEMPT.call(
        store, captured.attemptId, "discarded", null, captured.intent,
      );
    },
  });
}
