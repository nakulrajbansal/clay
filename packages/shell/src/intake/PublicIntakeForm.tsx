import { errorMessage } from "../app/error-message";
import { useMemo, useState } from "react";
import {
  IntakeSubmissionPlaintextV1,
  type IntakeSubmissionValueV1,
  type IntakeUploadedFileV1,
  type PublicFileRequestV1,
  type PublicIntakeLinkPayloadV1,
} from "@clay/schema/standalone/intake";
import { encodeBase64Url } from "./crypto";
import {
  mintIntakeSubmissionId, mintIntakeUploadId, parsePublicIntakeLink,
  sha256HexBrowser, submitEncryptedIntake,
} from "./client";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "text/plain": ["txt"],
});
const ACTIVE_MARKERS = [
  "/javascript", "/js", "/launch", "/openaction", "/embeddedfile", "/richmedia",
  "/xfa", "<script", "javascript:", "<iframe", "<!doctype html", "<?xml", "[autorun]",
];

function containsAscii(bytes: Uint8Array, marker: string): boolean {
  const needle = [...marker].map(character => character.charCodeAt(0));
  outer: for (let start = 0; start + needle.length <= bytes.length; start++) {
    for (let index = 0; index < needle.length; index++) {
      const raw = bytes[start + index]!;
      const lower = raw >= 65 && raw <= 90 ? raw + 32 : raw;
      if (lower !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function passiveSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "text/plain") {
    try { return !new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\u0000"); }
    catch { return false; }
  }
  return false;
}

function publicFileIssue(
  name: string,
  mime: string,
  bytes: Uint8Array,
  request: PublicFileRequestV1,
): string | null {
  if (mime === "application/pdf")
    return "PDF uploads are not accepted without a complete passive-content scanner";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (!(MIME_EXTENSIONS[mime] ?? []).includes(extension)) return "file name and type do not match";
  if (bytes.byteLength > request.maxBytes) return "file exceeds this request's size limit";
  if (!passiveSignature(bytes, mime)) return "file content does not match its passive type signature";
  if (ACTIVE_MARKERS.some(marker => containsAscii(bytes, marker))) return "active file content is prohibited";
  return null;
}

export function PublicIntakeForm({ payload, fetchImpl }: {
  payload: PublicIntakeLinkPayloadV1;
  fetchImpl?: FetchLike;
}): React.JSX.Element {
  const form = payload.form;
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = useMemo(() => Date.parse(form.delivery.expiresAt) <= Date.now(), [form]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || expired) return;
    setBusy(true); setError(null);
    try {
      const submissionValues: IntakeSubmissionValueV1[] = [];
      for (const field of form.fields) {
        const raw = values[field.fieldId];
        const absent = raw === undefined || raw === "";
        if (absent) {
          if (field.required) throw new Error(`${field.label} is required.`);
          continue;
        }
        let value: string | number | boolean = raw;
        if (field.type === "number" || field.type === "integer") {
          value = Number(raw);
          if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value)))
            throw new Error(`${field.label} must be a valid ${field.type}.`);
        }
        submissionValues.push({ fieldId: field.fieldId, value });
      }

      const uploads: IntakeUploadedFileV1[] = [];
      for (const request of form.fileRequests) {
        const selected = files[request.requestId] ?? [];
        if (request.required && selected.length === 0)
          throw new Error(`${request.label} is required.`);
        if (selected.length > request.maxFiles)
          throw new Error(`${request.label} allows at most ${request.maxFiles} file(s).`);
        for (const file of selected) {
          if (!request.allowedMimeTypes.includes(file.type as typeof request.allowedMimeTypes[number]))
            throw new Error(`${file.name} is not an allowed passive file type.`);
          if (file.size < 1 || file.size > request.maxBytes)
            throw new Error(`${file.name} exceeds the published file-size limit.`);
          const bytes = new Uint8Array(await file.arrayBuffer());
          const upload: IntakeUploadedFileV1 = {
            requestId: request.requestId,
            uploadId: mintIntakeUploadId(),
            name: file.name,
            mime: file.type as IntakeUploadedFileV1["mime"],
            size: bytes.byteLength,
            sha256: await sha256HexBrowser(bytes),
            bytes: encodeBase64Url(bytes),
          };
          const issue = publicFileIssue(file.name, file.type, bytes, request);
          if (issue) throw new Error(`${file.name}: ${issue}`);
          uploads.push(upload);
        }
      }
      const submission = IntakeSubmissionPlaintextV1.parse({
        schema: 1,
        formId: form.formId,
        formRevision: form.revision,
        submissionId: mintIntakeSubmissionId(),
        submittedAt: new Date().toISOString(),
        values: submissionValues,
        files: uploads,
      });
      await submitEncryptedIntake(payload, submission, fetchImpl);
      setSent(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setBusy(false); }
  };

  if (sent) return (
    <main className="ui ui-text-align-center ui-base-border-radius-c431a0 ui-label-display-b369c3 ui-label-gap-931d54 public-intake public-intake-success">
      <span className="ui ui-place-items-center ui-border-radius-50 public-intake-lock" aria-hidden="true">✓</span>
      <h1>Sent securely</h1>
      <p>Your information was encrypted on this device and is waiting for the owner to review it.</p>
    </main>
  );

  return (
    <main className="ui ui-base-border-radius-c431a0 ui-label-display-b369c3 ui-label-gap-931d54 public-intake">
      <header>
        <span className="ui ui-text-transform-uppercase public-intake-brand">Clay secure intake</span>
        <h1>{form.title}</h1>
        {form.description ? <p>{form.description}</p> : null}
        <p className="ui ui-font-size-13px ui-border-radius-9px public-intake-privacy">Encrypted here before upload. The relay cannot read your answers or files.</p>
      </header>
      {expired ? <div role="alert" className="ui ui-border-radius-9px ui-padding-10px-12px intake-alert">This form has expired. Ask the owner for a new link.</div> : (
        <form onSubmit={event => void submit(event)}>
          {form.fields.map(field => (
            <label key={field.fieldId} className="intake-field">
              <span>{field.label}{field.required ? " *" : ""}</span>
              {field.type === "enum" ? (
                <select name={field.fieldId} required={field.required} value={String(values[field.fieldId] ?? "")}
                  onChange={event => setValues(current => ({ ...current, [field.fieldId]: event.target.value }))}>
                  <option value="">Choose…</option>
                  {field.options.map(option => <option key={option}>{option}</option>)}
                </select>
              ) : field.type === "rich_text" ? (
                <textarea name={field.fieldId} required={field.required}
                  maxLength={field.maxLength ?? undefined}
                  value={String(values[field.fieldId] ?? "")}
                  onChange={event => setValues(current => ({ ...current, [field.fieldId]: event.target.value }))} />
              ) : field.type === "boolean" ? (
                <input name={field.fieldId} type="checkbox" checked={values[field.fieldId] === true}
                  onChange={event => setValues(current => ({ ...current, [field.fieldId]: event.target.checked }))} />
              ) : (
                <input name={field.fieldId} required={field.required}
                  type={field.type === "date" ? "date"
                    : field.type === "number" || field.type === "integer" ? "number" : "text"}
                  step={field.type === "integer" ? "1" : field.type === "number" ? "any" : undefined}
                  maxLength={field.maxLength ?? undefined}
                  value={String(values[field.fieldId] ?? "")}
                  onChange={event => setValues(current => ({ ...current, [field.fieldId]: event.target.value }))} />
              )}
            </label>
          ))}
          {form.fileRequests.map(request => (
            <label key={request.requestId} className="intake-field intake-file-field">
              <span>{request.label}{request.required ? " *" : ""}</span>
              <small>{request.allowedMimeTypes.join(", ")} · up to {Math.floor(request.maxBytes / 1024 / 1024)} MB</small>
              <input type="file" name={request.requestId} required={request.required}
                multiple={request.maxFiles > 1} accept={request.allowedMimeTypes.join(",")}
                onChange={event => setFiles(current => ({
                  ...current, [request.requestId]: [...(event.target.files ?? [])],
                }))} />
            </label>
          ))}
          {error ? <div role="alert" className="ui ui-border-radius-9px ui-padding-10px-12px intake-alert">{error}</div> : null}
          <button type="submit" className="primary" disabled={busy}>{busy ? "Encrypting…" : "Send securely"}</button>
          <small>Required fields are marked *. Files remain quarantined until the owner approves them.</small>
        </form>
      )}
    </main>
  );
}

export function PublicIntakePage(): React.JSX.Element {
  try {
    return <PublicIntakeForm payload={parsePublicIntakeLink(window.location.hash)} />;
  } catch (cause) {
    return <main className="ui ui-base-border-radius-c431a0 ui-label-display-b369c3 ui-label-gap-931d54 public-intake"><h1>Form unavailable</h1><div role="alert" className="ui ui-border-radius-9px ui-padding-10px-12px intake-alert">
      {errorMessage(cause)}
    </div></main>;
  }
}
