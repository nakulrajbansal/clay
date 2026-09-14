import { useMemo, useRef, useState } from "react";
import type { LegacyOwnerInventoryV1 } from "@clay/schema/legacy-owner";
import type { WorkerClient } from "./worker-client";
import { activateLegacyOwner, adoptLegacyOwner, cancelLegacyActivation, legacyOwnerSummaries, type LegacyOwnerVault } from "../legacy/owner-recovery";
import { IndexedDbLegacyOwnerVault } from "../legacy/owner-vault.browser";

export function LegacyOwnerRecovery(props: { worker: WorkerClient; origin: string; archive?: LegacyOwnerVault;
  legacyStorage?: Pick<Storage, "length" | "key">; onNewIntake?: () => void; onNewShare?: () => void; onNewApp?: () => void }) {
  const archive = useMemo(() => props.archive ?? new IndexedDbLegacyOwnerVault(), [props.archive]);
  const [inventory, setInventory] = useState<LegacyOwnerInventoryV1 | null>(null), [busy, setBusy] = useState(false), running = useRef(false);
  const [summaries, setSummaries] = useState<Awaited<ReturnType<typeof legacyOwnerSummaries>>>([]);
  const [oldShares, setOldShares] = useState(false), [message, setMessage] = useState<string | null>(null);
  const work = async (task: () => Promise<void>) => {
    if (running.current) return; running.current = true; setBusy(true); setMessage(null);
    try { await task(); } catch { setMessage("Ownership could not be recovered automatically, or recovery was interrupted. Originals are kept. Reconnect the proven original app to retry; copied apps never gain owner access. You may create a separate new form or share."); }
    finally { running.current = false; setBusy(false); }
  };
  const refresh = async (after: string | null = null) => {
    setInventory(await props.worker.legacyOwnerInventory(after)); setSummaries(await legacyOwnerSummaries(archive, props.origin));
    const storage = props.legacyStorage ?? localStorage;
    if (storage.length > 10_000) throw new Error("Legacy key inventory is bounded");
    let present = false; for (let i = 0; i < storage.length; i++) if (storage.key(i) === "clay_owner_share_receipts_v1") present = true;
    setOldShares(present); // NEVER getItem/parse a private legacy share URL/token.
  };
  return <section aria-labelledby="legacy-owner-title">
    <h3 id="legacy-owner-title">Legacy ownership compatibility</h3>
    <p>Private legacy originals are preserved, not exported, deleted or reassigned. The underlying app remains usable. A form or old share receipt without original catalog and request evidence cannot be recovered automatically.</p>
    <button disabled={busy} onClick={() => void work(() => refresh())}>Inspect legacy compatibility</button>
    {inventory ? <>
      {inventory.legacyState || inventory.unproven ? <p role="status">Some historical state has no proven recovery path. Keep it quarantined, reconnect its original app if available, or create a separate new form. Previous forms may remain active remotely; creating a new form does not revoke them.</p> : null}
      {oldShares ? <p role="status">Old sharing receipts did not record original app, generation or lineage. Ownership cannot be recovered automatically from a URL or copied table IDs. Original receipts are untouched. Existing source-bound V2 shares remain available in Sharing.</p> : null}
      {inventory.candidates.map(candidate => <div key={candidate.receipt.requestId}>
        <p>Original intake request {candidate.receipt.requestId}. Review and privately recover its exact historical response; no publication or data replacement occurs.</p>
        <button disabled={busy || (summaries.length >= 32 && !summaries.some(row => row.proof.receipt.requestId === candidate.receipt.requestId))} onClick={() => void work(async () => {
          await adoptLegacyOwner(props.worker, candidate, props.origin, archive); await refresh();
          setMessage("Original history was committed and read back privately. Private records retain their original custody; public history never creates missing keys. Nothing was republished.");
        })}>Recover proven original custody</button>
      </div>)}
      {inventory.next ? <button disabled={busy} onClick={() => void work(() => refresh(inventory.next))}>Next historical requests</button> : null}
      {summaries.map(row => <div key={row.key}>
        <p>{row.proof.form.publicForm.title}: {row.custodyCommitted ? "custody recovered" : "custody recovery interrupted; retry the original request"}.</p>
        {row.custodyCommitted && row.proof.activation === "original_metadata" && row.outcome !== "applied" ? <button disabled={busy
          || inventory.target.appInstanceId !== row.proof.source.appInstanceId || inventory.target.activeGenerationId !== row.proof.source.activeGenerationId
          || inventory.target.lineageEpoch !== row.proof.source.lineageEpoch} onClick={() => void work(async () => {
            await activateLegacyOwner(props.worker, row.key, inventory.target, props.origin, archive); await refresh();
            setMessage("Original public form metadata is available in Intake. Legacy bytes and old staged history remain preserved separately. No relay publication was sent.");
          })}>{row.outcome === "pending" ? "Retry original activation" : "Use original form in Intake"}</button> : null}
        {row.outcome === "pending" ? <button disabled={busy || inventory.target.appInstanceId !== row.proof.source.appInstanceId
          || inventory.target.activeGenerationId !== row.proof.source.activeGenerationId || inventory.target.lineageEpoch !== row.proof.source.lineageEpoch} onClick={() => void work(async () => {
          await cancelLegacyActivation(props.worker, row.key, props.origin, archive); await refresh();
        })}>Cancel original activation safely</button> : null}
        {row.proof.activation === "custody_only" ? <p>The old definition is superseded or no longer matches the source. Custody is preserved; create a new form after reviewing current fields.</p> : null}
      </div>)}
    </> : null}
    <p>Archives containing private historical values remain blocked even after custody recovery. Recovered custody is not an external backup. This device can retain up to 32 recovered historical responses. New forms and shares do not close an older remote publication.</p>
    {props.onNewShare ? <p>To create a separate share, open Data, select its table or view, then choose Share and review the snapshot.</p> : null}
    {props.onNewIntake ? <button disabled={busy} onClick={props.onNewIntake}>Create a new form</button> : null}
    {props.onNewShare ? <button disabled={busy} onClick={props.onNewShare}>Create a new share</button> : null}
    {props.onNewApp ? <><p>If an unprovable old request prevents a new form in this app, a separate app provides an independent source. Unknown old work is retained, not called closed.</p>
      <button disabled={busy} onClick={props.onNewApp}>Create a separate app</button></> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
