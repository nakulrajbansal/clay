import type { WorkerClient } from "../../src/app/worker-client";
import type { AutomationCommandPayloadV1 } from "@clay/schema/catalog";

/** UI-only deterministic fixture. Actual authority execution lives in the
 * separate WorkerClient/db-worker integration test, not this adapter. */
export function automationUiFixture(input: Record<string, (...args: any[]) => Promise<any>>): WorkerClient {
  let identity = 0; const results = new Map<string, unknown>();
  const target = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`,
    lineageEpoch: "1", protectionRevision: "3", digestSchema: 1, stateSha256: `sha256:${"c".repeat(64)}` };
  return { ...input,
    createMutationContext: () => ({ requestId: `req_${String.fromCharCode(100 + identity++).repeat(26)}` }),
    automationPresentation: async () => ({ authorityTarget: target, availability: { available: true, reason: null },
      rules: await input.listAutomations!(), runs: await input.automationRuns!(), notifications: await input.notifications!(),
      recipes: await input.automationRecipes!(), runtime: await input.automationRuntimeStatus!(), overview: await input.automationRuntimeOverview!(), trace: await input.semanticTrace!() }),
    mutationOutcome: async (_route: string, _payload: unknown, context: { requestId: string }) => results.has(context.requestId)
      ? { status: "recorded", current: true, result: results.get(context.requestId), target } : { status: "not_invoked" },
    automationCommand: async (value: AutomationCommandPayloadV1, context: { requestId: string }) => {
      const { route, payload } = value.command;
      const args = route === "saveAutomationDraft" ? [payload.input, payload.expectedRevision]
        : route === "saveAutomationRecipeDraft" ? [payload.request]
        : [payload.id, payload.expectedRevision, payload.simulation];
      const result = await input[route]!(...args); results.set(context.requestId, result ?? null); return result;
    },
  } as unknown as WorkerClient;
}
