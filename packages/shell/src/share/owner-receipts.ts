import { ShareIdV1, ShareRevokeTokenV1 } from "@clay/schema/share";
import { parseRecipientShareLocationV1 } from "./crypto";

const OWNER_SHARES_KEY_V1 = "clay_owner_share_receipts_v1";
const MAX_OWNER_RECEIPTS_V1 = 100;

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

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;

function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

function parseReceipt(value: unknown): OwnerShareReceiptV1 | null {
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

export function loadOwnerShareReceiptsV1(storage: StorageReader): OwnerShareReceiptV1[] {
  try {
    const parsed = JSON.parse(storage.getItem(OWNER_SHARES_KEY_V1) ?? "[]") as unknown;
    if (!Array.isArray(parsed) || parsed.length > MAX_OWNER_RECEIPTS_V1) return [];
    const receipts = parsed.map(parseReceipt);
    if (receipts.some(receipt => receipt === null)) return [];
    return receipts as OwnerShareReceiptV1[];
  } catch { return []; }
}

export function saveOwnerShareReceiptV1(
  storage: StorageWriter, receiptInput: OwnerShareReceiptV1,
): OwnerShareReceiptV1[] {
  const receipt = parseReceipt(receiptInput);
  if (!receipt) throw new Error("invalid owner share receipt");
  const without = loadOwnerShareReceiptsV1(storage)
    .filter(item => item.shareId !== receipt.shareId);
  const next = [receipt, ...without].slice(0, MAX_OWNER_RECEIPTS_V1);
  storage.setItem(OWNER_SHARES_KEY_V1, JSON.stringify(next));
  return next;
}

export function markOwnerShareRevokedV1(
  storage: StorageWriter, shareId: string, revokedAt: string,
): OwnerShareReceiptV1[] {
  ShareIdV1.parse(shareId);
  if (!instant(revokedAt)) throw new Error("invalid revocation instant");
  const current = loadOwnerShareReceiptsV1(storage);
  const found = current.find(receipt => receipt.shareId === shareId);
  if (!found) throw new Error("owner share receipt not found");
  const next = current.map(receipt => receipt.shareId === shareId
    ? { ...receipt, revokedAt } : receipt);
  storage.setItem(OWNER_SHARES_KEY_V1, JSON.stringify(next));
  return next;
}
