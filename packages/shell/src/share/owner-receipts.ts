import { ShareIdV1, ShareRevokeTokenV1 } from "@clay/schema/share";
import { parseRecipientShareLocationV1 } from "./crypto";

export type OwnerShareReceiptV1 = Readonly<{
  schema: 1;
  shareId: string;
  title: string;
  url: string;
  relayBaseUrl: string;
  expiresAt: string;
  createdAt: string;
  revokeToken: string;
  revokedAt: string | null;
}>;

function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

export function parseOwnerShareReceiptV1(value: unknown): OwnerShareReceiptV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    "schema", "shareId", "title", "url", "relayBaseUrl", "expiresAt",
    "createdAt", "revokeToken", "revokedAt",
  ];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.schema !== 1 || !ShareIdV1.safeParse(raw.shareId).success
      || typeof raw.title !== "string" || raw.title.length < 1 || raw.title.length > 200
      || typeof raw.url !== "string" || typeof raw.relayBaseUrl !== "string"
      || !ShareRevokeTokenV1.safeParse(raw.revokeToken).success
      || !instant(raw.expiresAt) || !instant(raw.createdAt)
      || (raw.revokedAt !== null && !instant(raw.revokedAt))) return null;
  try {
    const capability = parseRecipientShareLocationV1(raw.url);
    if (capability.shareId !== raw.shareId || capability.relayBaseUrl !== raw.relayBaseUrl)
      return null;
  } catch { return null; }
  return raw as OwnerShareReceiptV1;
}

// The legacy localStorage load/replace/revoke writers are retired. Existing
// receipts stay untouched; new owner workflows use the source-bound V2 vault.
