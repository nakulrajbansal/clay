import { useMemo, useRef, useState } from "react";
import { IntakeCommandPayloadV1 } from "@clay/schema/standalone/catalog";
import { IntakeOwnerClaimV1, IntakeOwnerWitnessV1 } from "@clay/schema/standalone/owner-witness";
import { IndexedDbIntakeWorkflows, type IntakeWorkflows, type IntakeWorkflowRecord } from "../intake/workflows";
import { IndexedDbIntakeOwnerVault } from "../intake/owner-custody.browser";
import type { IntakeOwnerVault } from "../intake/owner-custody";
import { IntakePublication, intakeConfiguration } from "../intake/publication";
import { IntakeSession } from "../intake/session";
import { ownerIntakeFetch } from "../intake/relay-owner-configuration";
import type { WorkerClient } from "./worker-client";
import { LegacyOwnerRecovery } from "./LegacyOwnerRecovery";

/** Public discovery is independent of current app selection. Nothing here can
 * recover source-free V1/private legacy values or inherit a copied app's keys. */
export function OriginalOwnerRecovery(props: { worker: WorkerClient; relayBaseUrl: string | null; publicBaseUrl: string;
  workflows?: IntakeWorkflows; ownerVault?: IntakeOwnerVault; fetchImpl?: typeof fetch; onNewIntake?: () => void; onNewShare?: () => void; onNewApp?: () => void }): React.JSX.Element {
  const workflows = useMemo(() => props.workflows ?? new IndexedDbIntakeWorkflows(), [props.workflows]);
  const vault = useMemo(() => props.ownerVault ?? new IndexedDbIntakeOwnerVault(), [props.ownerVault]);
  const [keys, setKeys] = useState<string[]>([]), [page, setPage] = useState(0), [records, setRecords] = useState<IntakeWorkflowRecord[]>([]);
  const [review, setReview] = useState<{ record: IntakeWorkflowRecord; witness: IntakeOwnerWitnessV1 } | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const running = useRef(false);
  const work = async (action: () => Promise<void>) => {
    if (running.current) return; running.current = true; setBusy(true); setMessage(null);
    try { await action(); } catch { setMessage("Original owner recovery is unproven or interrupted. All original work and custody were kept; retry with its original source and relay configuration."); }
    finally { running.current = false; setBusy(false); }
  };
  const load = async (inventory: string[], next: number) => {
    const rows: IntakeWorkflowRecord[] = [];
    for (const key of inventory.slice(next * 8, (next + 1) * 8)) {
      const row = await workflows.read(key);
      if (!row) throw new Error("Original workflow changed during discovery");
      if (!row.closed) rows.push(row);
    }
    setKeys(inventory); setPage(next); setRecords(rows); setReview(null);
    if (!rows.length) setMessage("No open owner work on this page. Source-free legacy values remain quarantined and are not inspected here.");
  };
  const configuration = useMemo(() => {
    try { return intakeConfiguration({ shellOrigin: location.origin, publicBaseUrl: props.publicBaseUrl, relayBaseUrl: props.relayBaseUrl }); }
    catch { return null; }
  }, [props.relayBaseUrl, props.publicBaseUrl]);
  const matches = !!configuration && !!review && "formId" in review.record.job
    && JSON.stringify(configuration) === JSON.stringify(review.record.job.configuration);
  const inspect = async (record: IntakeWorkflowRecord) => {
    if (!("formId" in record.job) || !record.job.save) throw new Error("An original creation invocation is required");
    const job = record.job, save = record.job.save;
    const claim = IntakeOwnerClaimV1.parse({ schema: 1, source: job.source, requestId: save.requestId,
      form: IntakeCommandPayloadV1.parse(save.payload).command.payload.form });
    const witness = IntakeOwnerWitnessV1.parse(await props.worker.intakeOwnerWitness(claim));
    if (JSON.stringify(witness.claim) !== JSON.stringify(claim)) throw new Error("Original owner evidence differs");
    setReview({ record, witness });
  };
  return <section aria-labelledby="original-owner-recovery-title">
    <LegacyOwnerRecovery worker={props.worker} origin={location.origin} onNewIntake={props.onNewIntake} onNewShare={props.onNewShare} onNewApp={props.onNewApp} />
    <h3 id="original-owner-recovery-title">Original owner recovery</h3>
    <p>Inspect retained public intake work, including work from a deleted app. Use Legacy ownership compatibility above for private historical custody. Unprovable originals stay quarantined; copies never inherit owner custody.</p>
    <button disabled={busy} onClick={() => void work(async () => {
      if (!workflows.listKeys) throw new Error("Public workflow inventory is unavailable");
      await load(await workflows.listKeys(location.origin), 0);
    })}>Inspect retained owner work</button>
    {records.map(record => <div key={record.key}>
      <p>{"formId" in record.job ? record.job.proposal.title : "Retained revocation"} — original app {record.appInstanceId}</p>
      {"formId" in record.job && record.job.save ? <button disabled={busy} onClick={() => void work(() => inspect(record))}>Review original owner proof</button>
        : <p>Original-source recovery for this work remains quarantined; no replacement identity will be created.</p>}
    </div>)}
    {keys.length > 8 ? <div>
      <button disabled={busy || page === 0} onClick={() => void work(() => load(keys, page - 1))}>Previous owner work</button>
      <button disabled={busy || (page + 1) * 8 >= keys.length} onClick={() => void work(() => load(keys, page + 1))}>Next owner work</button>
    </div> : null}
    {review ? <div role="status">
      {review.witness.status === "deleted" ? <>
        <p>The catalog proves deletion of this original app. Closing will terminalize its exact relay publication and preserve prior custody and requests. It will not restore, replace, or modify another app.</p>
        {!matches ? <p>Reconnect the original origin-bound relay configuration before closing.</p> : null}
        <button disabled={busy || !matches} onClick={() => void work(async () => {
          if (!configuration || !matches) throw new Error("Original relay configuration is required");
          const original = new IntakePublication(new IntakeSession(sessionStorage, props.worker, review.record.appInstanceId), vault, configuration,
            props.fetchImpl ?? ownerIntakeFetch(configuration.relayBaseUrl), workflows);
          await original.closeDeletedOriginal(review.witness);
          await load(keys, page);
          setMessage("Original publication closed. Prior custody and request history were kept. No source app was replaced.");
        })}>Close this deleted original publication</button>
      </> : <p>The original app is not proven deleted. Select and review the original app to recover its active form; another selected app cannot take ownership.</p>}
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
