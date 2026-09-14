/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act } from "preact/test-utils";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeProjectionPlaintextV1, encodeProjectionCsvV1, encodeProjectionPlaintextV1,
  type ProjectionArtifactV1, type ProjectionPlaintextV1, type ProjectionRequestV1,
} from "@clay/kernel/projection";
import {
  approveShareScopeV1, buildRecipientShareUrlV1, encryptApprovedShareV1,
} from "../src/share/crypto";
import { ShareView } from "../src/share/ShareView";
import { ShareRelayClientError, type ShareRelayClient } from "../src/share/relay-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-07T12:00:00.000Z");
const fieldId = "fld_018f0000-0000-7000-8000-000000000002";
const fileId = "file_018f0000000070008000000000000003";
const request: ProjectionRequestV1 = {
  schema: 1,
  kind: "record",
  expectedSchemaVersion: 4,
  tableId: "tbl_018f0000-0000-7000-8000-000000000001",
  fieldIds: [fieldId],
  recordId: "018f0000-0000-7000-8000-000000000004",
  options: { includeRecordIds: false, redactedFieldIds: [] },
};
const attachmentSource = {
  tableId: request.tableId,
  fieldId: "fld_018f0000-0000-7000-8000-000000000005",
  recordId: request.recordId,
} as const;

function artifact(): ProjectionArtifactV1 {
  const manifest = {
    schema: "ProjectionManifestV1" as const,
    kind: "record" as const,
    title: "Customer status",
    table: "customers",
    schemaVersion: 4,
    fieldCount: 1,
    rowCount: 1,
    fields: [{ label: "Status", name: "status", redacted: false as const,
      source: "field" as const, type: "text" as const }],
    view: null,
    policies: {
      relations: "friendly_labels" as const, recordIds: "excluded" as const,
      attachments: "excluded" as const, hiddenFields: "excluded" as const,
      inactiveFields: "excluded" as const, unselectedFields: "excluded" as const,
      blankValues: "empty_string" as const,
      dates: "stored_value_no_timezone_conversion" as const,
      csvFormula: "prefix_apostrophe" as const,
    },
    redactions: [], dependencies: [],
    renderer: { id: "clay-semantic-table" as const, version: 1 as const },
    limits: { rows: 5000 as const, fields: 30 as const,
      plaintextBytes: 8388608 as const, sourceRows: 20000 as const },
    completeness: { truncated: false as const, reason: null },
    csv: { byteCount: 0, formulaNeutralizedCells: 0 },
  };
  const draft = { schema: "ProjectionPlaintextV1" as const,
    manifest, rows: [["Ready for customer"]] } satisfies ProjectionPlaintextV1;
  const csv = encodeProjectionCsvV1(draft);
  const final = { ...draft, manifest: { ...manifest,
    csv: { byteCount: csv.byteLength, formulaNeutralizedCells: 0 } } };
  const plaintext = encodeProjectionPlaintextV1(final);
  return { projection: decodeProjectionPlaintextV1(plaintext), plaintext, csv };
}

async function encryptedFixture() {
  const bytes = new TextEncoder().encode("APPROVED RECIPIENT FILE");
  const attachment = {
    id: fileId, name: "result.txt", mime: "text/plain", size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: attachmentSource,
    bytes,
  } as const;
  const approval = await approveShareScopeV1(request, [attachment], artifact(), NOW);
  const encrypted = await encryptApprovedShareV1({
    approval, request, artifact: artifact(),
    attachments: [attachment],
    expiresAt: "2026-09-08T12:00:00.000Z",
  });
  const href = buildRecipientShareUrlV1({
    viewerOrigin: "https://clay.example",
    relayBaseUrl: "https://relay.example/api",
    shareId: encrypted.request.shareId,
    key: encrypted.key,
  });
  return { bytes, encrypted, href };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 3_000) throw new Error(document.body.innerHTML);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true, value: vi.fn(() => "blob:shared-file"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true, value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("account-free F1 recipient view", () => {
  it("fetches by relay ID only, decrypts locally, and renders a static snapshot", async () => {
    const { encrypted, href } = await encryptedFixture();
    const read = vi.fn(async () => ({
      schema: 1 as const,
      shareId: encrypted.request.shareId,
      expiresAt: encrypted.request.expiresAt,
      envelope: encrypted.request.envelope,
    }));
    const relay: ShareRelayClient = {
      baseUrl: "https://relay.example/api", create: vi.fn(), read, terminalize: vi.fn(), revoke: vi.fn(),
    };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareView
      href={href}
      now={() => NOW}
      clientFactory={baseUrl => {
        expect(baseUrl).toBe("https://relay.example/api");
        return relay;
      }}
    />));
    await waitFor(() => document.body.querySelector(".share-view tbody") !== null);

    expect(read).toHaveBeenCalledWith(encrypted.request.shareId);
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(read.mock.calls)).not.toContain(encrypted.key);
    expect(document.body.textContent).toContain("Customer status");
    expect(document.body.textContent).toContain("Ready for customer");
    expect(document.body.textContent).toContain("Frozen read-only snapshot");
    expect(document.body.textContent).toContain("result.txt");
    expect(document.body.textContent).not.toContain("MUST_NOT_LEAK");
    expect(document.body.querySelector("input, textarea, select, [contenteditable=true]")).toBeNull();
    expect([...document.body.querySelectorAll("button")].map(button => button.textContent))
      .toEqual(["Download result.txt"]);
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute("content"))
      .toBe("no-referrer");
    await act(async () => root.unmount());
  });

  it("downloads only the locally decrypted approved attachment", async () => {
    const { bytes, encrypted, href } = await encryptedFixture();
    const captured: { value: Blob | null } = { value: null };
    vi.mocked(URL.createObjectURL).mockImplementation(blob => {
      if (!(blob instanceof Blob)) throw new Error("expected a Blob download");
      captured.value = blob;
      return "blob:approved-share";
    });
    const relay: ShareRelayClient = {
      baseUrl: "https://relay.example/api", create: vi.fn(), terminalize: vi.fn(), revoke: vi.fn(),
      read: async () => ({ schema: 1, shareId: encrypted.request.shareId,
        expiresAt: encrypted.request.expiresAt, envelope: encrypted.request.envelope }),
    };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareView href={href} now={() => NOW}
      clientFactory={() => relay} />));
    await waitFor(() => document.body.textContent?.includes("Download result.txt") ?? false);
    await act(async () => document.body.querySelector<HTMLButtonElement>("button")!.click());
    expect(captured.value).toBeInstanceOf(Blob);
    expect(captured.value?.size).toBe(bytes.byteLength);
    expect(captured.value?.type).toBe("text/plain");
    await act(async () => root.unmount());
  });

  it.each([
    ["expired", "This share link has expired"],
    ["revoked", "This share link was revoked"],
    ["not_found", "This share link is unavailable"],
  ])("shows a safe terminal state for %s without stale output", async (code, message) => {
    const { href } = await encryptedFixture();
    const relay: ShareRelayClient = {
      baseUrl: "https://relay.example/api", create: vi.fn(), terminalize: vi.fn(), revoke: vi.fn(),
      read: vi.fn(async () => { throw new ShareRelayClientError(code, code === "not_found" ? 404 : 410); }),
    };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareView href={href} now={() => NOW}
      clientFactory={() => relay} />));
    await waitFor(() => document.body.getAttribute("data-share-state") === "error");
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toContain("Ready for customer");
    expect(document.body.querySelector("table, a, button")).toBeNull();
    await act(async () => root.unmount());
  });

  it("does not contact any relay when the fragment capability is absent or malformed", async () => {
    const read = vi.fn();
    const factory = vi.fn((): ShareRelayClient => ({
      baseUrl: "https://relay.example", create: vi.fn(), read, terminalize: vi.fn(), revoke: vi.fn(),
    }));
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareView
      href="https://clay.example/share/shr_abcdefghijklmnopqrstuvwxyz"
      clientFactory={factory}
    />));
    await waitFor(() => document.body.getAttribute("data-share-state") === "error");
    expect(document.body.textContent).toContain("missing its decryption key");
    expect(factory).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("rejects an already expired relay response before exposing decrypted output", async () => {
    const { encrypted, href } = await encryptedFixture();
    const relay: ShareRelayClient = {
      baseUrl: "https://relay.example/api", create: vi.fn(), terminalize: vi.fn(), revoke: vi.fn(),
      read: vi.fn(async () => ({ schema: 1 as const, shareId: encrypted.request.shareId,
        expiresAt: encrypted.request.expiresAt, envelope: encrypted.request.envelope })),
    };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShareView href={href}
      now={() => new Date(encrypted.request.expiresAt)} clientFactory={() => relay} />));
    await waitFor(() => document.body.getAttribute("data-share-state") === "error");
    expect(document.body.textContent).toContain("expired");
    expect(document.body.textContent).not.toContain("Ready for customer");
    await act(async () => root.unmount());
  });
});
