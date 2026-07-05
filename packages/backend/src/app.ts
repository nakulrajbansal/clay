// The hosted mutation proxy (doc 07, Phase 1.1). Thin: it assembles the
// prompt server-side and calls the model with a server-held key, so users
// need no browser key (ADR-011). Records never reach it — the body is the
// S1 context (schema shapes + intent) only (B2, ADR-009).
//
// It relays the model's RAW output; the client (worker) runs hydrate + Zod
// + the repair loop, calling /mutations/repair per round. This diverges
// from doc 07's "validate + never relay malformed" because the pipeline is
// client-orchestrated (OPEN-QUESTIONS Q24); it is safe because the client
// validates before executing anything.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { MutationClient, type S1Context } from "@clay/mutation";

const BODY_CAP = 64 * 1024;   // doc 07: body <= 64KB

export type BackendOptions = {
  apiKey: string | undefined;
  /** injectable for tests; defaults to a real MutationClient */
  makeClient?: (apiKey: string) => Pick<MutationClient, "rawPlan" | "rawRepair">;
};

export function createApp(opts: BackendOptions): Hono {
  const app = new Hono();
  app.use("/*", cors({ origin: (o) => o ?? "*", allowMethods: ["POST", "GET", "OPTIONS"] }));

  const client = (): Pick<MutationClient, "rawPlan" | "rawRepair"> => {
    if (!opts.apiKey) throw new Error("server is not configured with a model key");
    return (opts.makeClient ?? ((k) =>
      new MutationClient({ mode: "byo", apiKey: k }, { modelRepair: true })))(opts.apiKey);
  };

  app.get("/healthz", (c) => c.json({ ok: true, model: Boolean(opts.apiKey) }));

  const readBody = async (c: Context): Promise<unknown> => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > BODY_CAP) throw new Response("body too large", { status: 413 });
    return c.req.json();
  };

  app.post("/mutations/plan", async (c) => {
    let body: { context?: S1Context };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context) return c.json({ error: "missing context" }, 400);
    try {
      const raw = await client().rawPlan(body.context);
      return c.body(raw, 200, { "content-type": "application/json" });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.post("/mutations/repair", async (c) => {
    let body: { context?: S1Context; prior_plan?: string; failures?: string[] };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context || typeof body.prior_plan !== "string")
      return c.json({ error: "missing context or prior_plan" }, 400);
    try {
      const raw = await client().rawRepair(body.context, body.prior_plan, body.failures ?? []);
      return c.body(raw, 200, { "content-type": "application/json" });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  return app;
}
