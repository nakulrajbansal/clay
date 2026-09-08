import { useEffect, useState } from "react";
import {
  decryptShareSnapshotV1, parseRecipientShareLocationV1,
  type DecryptedShareAttachmentV1, type DecryptedShareSnapshotV1,
} from "./crypto";
import {
  BrowserShareRelayClient, ShareRelayClientError, type ShareRelayClient,
} from "./relay-client";
import "./ShareView.css";

type ViewState =
  | { state: "loading" }
  | { state: "ready"; share: DecryptedShareSnapshotV1; expiresAt: string }
  | { state: "error"; message: string };

function relayMessage(error: unknown): string {
  if (error instanceof ShareRelayClientError) {
    if (error.code === "expired") return "This share link has expired.";
    if (error.code === "revoked") return "This share link was revoked.";
    if (error.code === "not_found") return "This share link is unavailable.";
    return "This encrypted share could not be loaded safely.";
  }
  return error instanceof Error ? error.message : "This encrypted share could not be opened.";
}

function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function downloadAttachment(file: DecryptedShareAttachmentV1): void {
  const url = URL.createObjectURL(new Blob([ownBuffer(file.bytes)], { type: file.mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener noreferrer";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function installNoReferrerPolicy(): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "referrer";
    document.head.append(meta);
  }
  meta.content = "no-referrer";
}

export function ShareView(props: Readonly<{
  href?: string;
  now?: () => Date;
  clientFactory?: (baseUrl: string) => ShareRelayClient;
}>): React.JSX.Element {
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const href = props.href ?? window.location.href;
  const clock = props.now ?? (() => new Date());
  const clientFactory = props.clientFactory
    ?? ((baseUrl: string): ShareRelayClient => new BrowserShareRelayClient(baseUrl, null));

  useEffect(() => {
    installNoReferrerPolicy();
    let active = true;
    setView({ state: "loading" });
    void (async () => {
      try {
        // URL fragments are parsed locally. Only the opaque relay id is ever
        // handed to read(), whose transport omits credentials and referrers.
        const capability = parseRecipientShareLocationV1(href);
        const snapshot = await clientFactory(capability.relayBaseUrl).read(capability.shareId);
        if (Date.parse(snapshot.expiresAt) <= clock().getTime())
          throw new ShareRelayClientError("expired", 410);
        const share = await decryptShareSnapshotV1(snapshot, capability.key);
        if (active) setView({ state: "ready", share, expiresAt: snapshot.expiresAt });
      } catch (error) {
        if (active) setView({ state: "error", message: relayMessage(error) });
      }
    })();
    return () => { active = false; };
  }, [href, props.clientFactory, props.now]);

  useEffect(() => {
    document.body.setAttribute("data-share-state", view.state);
    return () => document.body.removeAttribute("data-share-state");
  }, [view.state]);

  if (view.state === "loading") return <main className="share-view share-view-state">
    <div className="share-view-mark" aria-hidden="true">C</div>
    <p role="status" aria-live="polite">Opening encrypted share…</p>
  </main>;

  if (view.state === "error") return <main className="share-view share-view-state">
    <div className="share-view-mark" aria-hidden="true">C</div>
    <h1>Share unavailable</h1>
    <p role="alert">{view.message}</p>
    <small>No account or sign-in is required. Ask the sender for a fresh link if needed.</small>
  </main>;

  const { projection } = view.share;
  return <main className="share-view">
    <header className="share-view-header">
      <div className="share-view-mark" aria-hidden="true">C</div>
      <div>
        <span>Shared from Clay</span>
        <h1>{projection.manifest.title}</h1>
        <p>Frozen read-only snapshot · no account needed</p>
      </div>
      <time dateTime={view.expiresAt}>
        Expires {new Date(view.expiresAt).toLocaleString()}
      </time>
    </header>

    <section className="share-view-card" aria-label="Shared result">
      <div className="share-view-summary">
        <strong>{projection.manifest.rowCount} rows × {projection.manifest.fieldCount} fields</strong>
        <span>Complete snapshot · hidden and unselected fields excluded</span>
      </div>
      <div className="share-view-table" role="region" aria-label="Shared result table" tabIndex={0}>
        <table>
          <thead><tr>{projection.manifest.fields.map((field, index) =>
            <th scope="col" key={`${field.name}-${index}`}>{field.label}</th>)}</tr></thead>
          <tbody>{projection.rows.map((row, rowIndex) => <tr key={rowIndex}>
            {row.map((value, fieldIndex) => <td key={fieldIndex}>{value || "—"}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </section>

    {view.share.attachments.length > 0 ? <section className="share-view-card share-files"
      aria-label="Approved shared files">
      <h2>Approved files</h2>
      <p>Only files the sender checked separately are included.</p>
      {view.share.attachments.map(file => <article key={file.id}>
        <div><strong>{file.name}</strong><small>{file.mime} · {file.size} bytes</small></div>
        <button type="button" onClick={() => downloadAttachment(file)}>
          Download {file.name}
        </button>
      </article>)}
    </section> : null}

    <footer className="share-view-footer">
      This page can display this frozen result only. It cannot edit or access the sender’s Clay app.
    </footer>
  </main>;
}
