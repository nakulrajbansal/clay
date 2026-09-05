import { sha256HexSync } from "./state-digest";

export type StateLeafFieldV1 =
  | { name: string; kind: "null" }
  | { name: string; kind: "integer"; value: string }
  | { name: string; kind: "real"; value: number }
  | { name: string; kind: "text"; value: string }
  | { name: string; kind: "content"; sha256: string; bytes: string };

export type StateLeafV1 = { key: string; sha256: string };

const encoder = new TextEncoder();
const LEAF_DOMAIN = encoder.encode("clay.state.leaf.v1");
const BUCKET_KEY_DOMAIN = encoder.encode("clay.state.bucket-key.v1");
const BUCKET_DOMAIN = encoder.encode("clay.state.bucket.v1");
const ROOT_DOMAIN = encoder.encode("clay.state.root.v1");
const SHA256 = /^sha256:([0-9a-f]{64})$/;
const UINT64 = /^(?:0|[1-9][0-9]{0,19})$/;
const INT64 = /^(?:0|-?[1-9][0-9]{0,18})$/;
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const KEY = /^[a-zA-Z0-9_./:-]{1,1024}$/;
const FIELD_NAME = /^[a-zA-Z0-9_./:-]{1,256}$/;

const compareCanonicalName = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (!Number.isSafeInteger(size)) throw new Error("Merkle frame is too large");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error("invalid uint16");
  return new Uint8Array([value >>> 8, value & 0xff]);
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("invalid uint32");
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function u64(value: bigint): Uint8Array {
  if (value < 0n || value > UINT64_MAX) throw new Error("invalid uint64");
  const output = new Uint8Array(8);
  let remaining = value;
  for (let index = 7; index >= 0; index--) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function hashParts(parts: Uint8Array[]): string {
  return `sha256:${sha256HexSync(concat(parts))}`;
}

function digestBytes(value: string): Uint8Array {
  const match = SHA256.exec(value);
  if (!match) throw new Error("invalid SHA-256");
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index++)
    output[index] = Number.parseInt(match[1]!.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function exactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error("invalid state leaf field shape");
}

function fieldPayload(field: StateLeafFieldV1): { tag: number; bytes: Uint8Array } {
  if (!field || typeof field !== "object" || !FIELD_NAME.test(String(field.name)))
    throw new Error("invalid state leaf field");
  switch (field.kind) {
    case "null":
      exactKeys(field, ["name", "kind"]);
      return { tag: 0, bytes: new Uint8Array() };
    case "integer": {
      exactKeys(field, ["name", "kind", "value"]);
      if (typeof field.value !== "string" || !INT64.test(field.value))
        throw new Error("invalid canonical integer");
      const value = BigInt(field.value);
      if (value < INT64_MIN || value > INT64_MAX) throw new Error("integer exceeds int64");
      return { tag: 1, bytes: encoder.encode(field.value) };
    }
    case "real": {
      exactKeys(field, ["name", "kind", "value"]);
      if (typeof field.value !== "number" || !Number.isFinite(field.value))
        throw new Error("invalid canonical real");
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, Object.is(field.value, -0) ? 0 : field.value, false);
      return { tag: 2, bytes };
    }
    case "text":
      exactKeys(field, ["name", "kind", "value"]);
      if (typeof field.value !== "string") throw new Error("invalid canonical text");
      return { tag: 3, bytes: encoder.encode(field.value) };
    case "content": {
      exactKeys(field, ["name", "kind", "sha256", "bytes"]);
      if (typeof field.bytes !== "string" || !UINT64.test(field.bytes))
        throw new Error("invalid canonical content length");
      const length = BigInt(field.bytes);
      if (length > UINT64_MAX) throw new Error("content length exceeds uint64");
      return { tag: 4, bytes: concat([digestBytes(field.sha256), u64(length)]) };
    }
    default:
      throw new Error("unsupported state leaf field kind");
  }
}

function keyBytes(key: string): Uint8Array {
  if (typeof key !== "string" || !KEY.test(key)) throw new Error("invalid state leaf key");
  return encoder.encode(key);
}

export function stateLeafHashV1(key: string, fields: StateLeafFieldV1[]): string {
  const keyData = keyBytes(key);
  if (!Array.isArray(fields)) throw new Error("state leaf fields must be an array");
  const ordered = [...fields].sort((left, right) => compareCanonicalName(left.name, right.name));
  for (let index = 1; index < ordered.length; index++)
    if (ordered[index - 1]!.name === ordered[index]!.name) throw new Error("duplicate state leaf field");
  const parts = [LEAF_DOMAIN, u32(keyData.byteLength), keyData, u32(ordered.length)];
  for (const field of ordered) {
    const name = encoder.encode(field.name);
    const payload = fieldPayload(field);
    parts.push(u32(name.byteLength), name, new Uint8Array([payload.tag]), u64(BigInt(payload.bytes.byteLength)), payload.bytes);
  }
  return hashParts(parts);
}

export function stateLeafBucketV1(key: string): number {
  const data = keyBytes(key);
  const hash = digestBytes(hashParts([BUCKET_KEY_DOMAIN, u32(data.byteLength), data]));
  return (hash[0]! << 2) | (hash[1]! >>> 6);
}

export function stateBucketRootV1(bucket: number, leaves: StateLeafV1[]): string {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= 1024) throw new Error("invalid state bucket");
  const ordered = [...leaves].sort((left, right) => compareCanonicalName(left.key, right.key));
  const parts = [BUCKET_DOMAIN, u16(bucket), u32(ordered.length)];
  for (let index = 0; index < ordered.length; index++) {
    const leaf = ordered[index]!;
    if (index > 0 && ordered[index - 1]!.key === leaf.key) throw new Error("duplicate state leaf key");
    if (stateLeafBucketV1(leaf.key) !== bucket) throw new Error("state leaf is in the wrong bucket");
    const key = keyBytes(leaf.key);
    parts.push(u32(key.byteLength), key, digestBytes(leaf.sha256));
  }
  return hashParts(parts);
}

export function stateRootFromBucketsV1(bucketRoots: string[]): string {
  if (!Array.isArray(bucketRoots) || bucketRoots.length !== 1024)
    throw new Error("state root requires exactly 1024 buckets");
  const parts = [ROOT_DOMAIN, u16(1024)];
  for (let index = 0; index < bucketRoots.length; index++)
    parts.push(u16(index), digestBytes(bucketRoots[index]!));
  return hashParts(parts);
}

export function stateRootV1(leaves: StateLeafV1[]): string {
  if (!Array.isArray(leaves)) throw new Error("state leaves must be an array");
  const buckets = Array.from({ length: 1024 }, () => [] as StateLeafV1[]);
  const seen = new Set<string>();
  for (const leaf of leaves) {
    exactKeys(leaf, ["key", "sha256"]);
    if (seen.has(leaf.key)) throw new Error("duplicate state leaf key");
    seen.add(leaf.key);
    digestBytes(leaf.sha256);
    buckets[stateLeafBucketV1(leaf.key)]!.push(leaf);
  }
  return stateRootFromBucketsV1(
    buckets.map((bucket, index) => stateBucketRootV1(index, bucket)),
  );
}
