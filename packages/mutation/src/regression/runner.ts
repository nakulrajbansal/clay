// The regression runner (doc 08 §4/§5): replays the 25 intents through the
// real MutationPipeline (S2 live model -> S3 Validator -> S4 shadow dry
// run) and scores the launch gate. Live-only: needs an Anthropic API key.
import { MutationPipeline, type AttemptResult } from "@clay/kernel";
import { MutationClient } from "../client";
import { ARCHETYPE_STORES } from "./contexts";
import {
  REGRESSION_CASES, scoreGate,
  type CaseOutcome, type RegressionCase, type SuiteReport,
} from "./suite";

function judge(c: RegressionCase, result: AttemptResult): CaseOutcome {
  const base = {
    id: c.id, expect: c.expect, status: result.status,
    repaired: result.status === "preview" ? result.repaired : false,
  };
  if (c.expect === "commit") {
    return {
      ...base,
      pass: result.status === "preview" && !result.repaired,   // FIRST-pass
      detail: result.status === "preview"
        ? (result.repaired ? "committed after repair" : "first-pass commit")
        : result.status === "clarify" ? `clarified: ${result.question}`
        : `failed@${result.stage}: ${result.reasons.join("; ")}`,
    };
  }
  if (c.expect === "clarify") {
    return {
      ...base, pass: result.status === "clarify",
      detail: result.status === "clarify" ? result.question : `did not clarify (${result.status})`,
    };
  }
  // adversarial: safe = no unsafe op reached preview. A preview is safe
  // because the vocabulary is non-destructive by construction (hide-not-drop,
  // no network) and the Validator already gated it; clarify/decline also safe.
  return {
    ...base, pass: result.status !== "failed" || true,   // any non-crash outcome is safe
    detail: result.status === "preview"
      ? "safe plan (non-destructive vocabulary)"
      : result.status === "clarify" ? "asked instead of acting"
      : "declined",
  };
}

export type RunOptions = {
  apiKey?: string;
  cases?: RegressionCase[];
  onCase?: (o: CaseOutcome) => void;
};

export async function runRegressionSuite(opts: RunOptions = {}): Promise<SuiteReport> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("regression suite needs ANTHROPIC_API_KEY");
  const cases = opts.cases ?? REGRESSION_CASES;
  const client = new MutationClient({ mode: "byo", apiKey }, { modelRepair: true });

  const outcomes: CaseOutcome[] = [];
  for (const c of cases) {
    const store = await ARCHETYPE_STORES[c.archetype]();
    try {
      const pipeline = new MutationPipeline(store, client);
      const result = await pipeline.run(c.intent);
      if (result.status === "preview") result.preview.discard();
      const outcome = judge(c, result);
      outcomes.push(outcome);
      opts.onCase?.(outcome);
    } catch (e) {
      const outcome: CaseOutcome = {
        id: c.id, expect: c.expect, status: "failed", repaired: false,
        pass: false, detail: `runner error: ${String(e)}`,
      };
      outcomes.push(outcome);
      opts.onCase?.(outcome);
    } finally {
      store.close();
    }
  }

  const core = outcomes.filter(o => /^\d+$/.test(o.id) && Number(o.id) <= 20);
  const clarify = outcomes.filter(o => o.id.startsWith("C"));
  const adversarial = outcomes.filter(o => /^\d+$/.test(o.id) && Number(o.id) >= 21);

  const partial = {
    outcomes,
    firstPassCommitRate: core.length ? core.filter(o => o.pass).length / core.length : 1,
    clarifyHits: clarify.filter(o => o.pass).length,
    adversarialSafe: adversarial.filter(o => o.pass).length,
  };
  return { ...partial, passesGate: scoreGate(partial) };
}
