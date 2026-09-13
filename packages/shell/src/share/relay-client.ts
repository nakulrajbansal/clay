import {
  ShareCreateRequestV1, ShareCreateResponseV1, ShareIdV1,
  ShareRelayErrorV1, ShareRelaySnapshotV1, ShareRevokeRequestV1,
  ShareRevokeResponseV1, ShareTerminalRequestV1, ShareTerminalResponseV1,
  type ShareCreateRequestV1 as ShareCreateRequest,
  type ShareCreateResponseV1 as ShareCreateResponse,
  type ShareRelaySnapshotV1 as ShareRelaySnapshot,
  type ShareRevokeResponseV1 as ShareRevokeResponse,
} from "@clay/schema/share";
import { boundedRelayJson } from "../app/bounded-relay-response";
import { relayRequestSha256 } from "../app/relay-request-identity";

export type ShareRelayClient = Readonly<{
  baseUrl: string;
  create(request: ShareCreateRequest): Promise<ShareCreateResponse>;
  read(shareId: string): Promise<ShareRelaySnapshot>;
  revoke(shareId: string, revokeToken: string): Promise<ShareRevokeResponse>;
  terminalize(request: ShareCreateRequest, revokeToken: string): Promise<ShareTerminalResponseV1>;
}>;

export class ShareRelayClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = `Share relay rejected the request: ${code}`,
  ) {
    super(message);
    this.name = "ShareRelayClientError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("The share relay URL is invalid."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new Error("The share relay URL must use HTTPS (or loopback HTTP) without credentials.");
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
}

async function jsonBody(response: Response): Promise<unknown> {
  try { return await boundedRelayJson(response, response.ok ? 12 * 1024 * 1024 : 8 * 1024); }
  catch { throw new ShareRelayClientError("invalid_response", response.status,
    "The share relay returned invalid JSON."); }
}

async function checked<T>(
  response: Response,
  parse: { safeParse(value: unknown): { success: boolean; data?: T } },
): Promise<T> {
  const body = await jsonBody(response);
  if (!response.ok) {
    const error = ShareRelayErrorV1.safeParse(body);
    throw new ShareRelayClientError(
      error.success ? error.data.error : "relay_error",
      response.status,
    );
  }
  const parsed = parse.safeParse(body);
  if (!parsed.success)
    throw new ShareRelayClientError("invalid_response", response.status,
      "Invalid share relay successful response.");
  return parsed.data!;
}

export class BrowserShareRelayClient implements ShareRelayClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly session: string | null,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async create(requestInput: ShareCreateRequest): Promise<ShareCreateResponse> {
    const request = ShareCreateRequestV1.parse(requestInput);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.session) headers.authorization = `Bearer ${this.session}`;
    const response = await this.fetcher(`${this.baseUrl}/shares`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    return checked(response, ShareCreateResponseV1);
  }

  async read(shareIdInput: string): Promise<ShareRelaySnapshot> {
    const shareId = ShareIdV1.parse(shareIdInput);
    const response = await this.fetcher(`${this.baseUrl}/shares/${shareId}`, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    return checked(response, ShareRelaySnapshotV1);
  }

  async revoke(shareIdInput: string, revokeToken: string): Promise<ShareRevokeResponse> {
    const shareId = ShareIdV1.parse(shareIdInput);
    const request = ShareRevokeRequestV1.parse({ schema: 1, revokeToken });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.session) headers.authorization = `Bearer ${this.session}`;
    const response = await this.fetcher(`${this.baseUrl}/shares/${shareId}/revoke`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    return checked(response, ShareRevokeResponseV1);
  }

  async terminalize(input: ShareCreateRequest, revokeToken: string): Promise<ShareTerminalResponseV1> {
    const body = ShareTerminalRequestV1.parse({ schema: 1, request: input, revokeToken });
    const identity = await relayRequestSha256(body.request);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.session) headers.authorization = `Bearer ${this.session}`;
    const response = await this.fetcher(`${this.baseUrl}/shares/${body.request.shareId}/terminalize`, {
      method: "POST", headers, body: JSON.stringify(body), credentials: "include", redirect: "error",
      cache: "no-store", referrerPolicy: "no-referrer",
    });
    const receipt = await checked(response, ShareTerminalResponseV1);
    if (receipt.shareId !== body.request.shareId || receipt.expiresAt !== body.request.expiresAt || receipt.requestSha256 !== identity)
      throw new Error("Share terminal acknowledgement differs from the original identity");
    return receipt;
  }
}
