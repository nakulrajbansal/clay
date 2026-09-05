import { describe, expect, it } from "vitest";
import {
  stateLeafBucketV1,
  stateLeafHashV1,
  stateRootV1,
  type StateLeafFieldV1,
} from "../src/state-merkle";

const key = "row/tbl_abc/rec_123";
const fields: StateLeafFieldV1[] = [
  { name: "nothing", kind: "null" },
  { name: "count", kind: "integer", value: "-7" },
  { name: "ratio", kind: "real", value: -0 },
  { name: "title", kind: "text", value: "Café" },
  { name: "file", kind: "content", sha256: `sha256:${"11".repeat(32)}`, bytes: "10485760" },
];

describe("canonical logical state Merkle protocol v1", () => {
  it("matches independent golden vectors for leaves, buckets, and roots", () => {
    const first = stateLeafHashV1(key, fields);
    expect(first).toBe("sha256:0a08665ca489f226d5f132d126e42f8785afedcf9b6057720a5e7cc3192bd5a9");
    expect(stateLeafBucketV1(key)).toBe(743);
    const secondKey = "schema/table/tbl_abc";
    const second = stateLeafHashV1(secondKey, [
      { name: "name", kind: "text", value: "Projects" },
    ]);
    expect(second).toBe("sha256:3f12fe7c939d8b8501d483fa57d9b97b6dd4a5feed63d63cba135d58d226bbc1");
    expect(stateLeafBucketV1(secondKey)).toBe(882);
    expect(stateRootV1([])).toBe(
      "sha256:578c0424ddaed67d6f0c081a40e3c95bd0c7db2a7a9002fd565c74622c26079d",
    );
    expect(stateRootV1([{ key, sha256: first }, { key: secondKey, sha256: second }])).toBe(
      "sha256:b485011eea25bd27640b16e339afe1ff885463d6ee18bd025cfcbc8c5539b17c",
    );
  });

  it("is independent of field and leaf input order", () => {
    const forward = stateLeafHashV1(key, fields);
    expect(stateLeafHashV1(key, [...fields].reverse())).toBe(forward);
    const other = stateLeafHashV1("row/tbl_abc/rec_456", [
      { name: "title", kind: "text", value: "Other" },
    ]);
    expect(stateRootV1([{ key, sha256: forward }, { key: "row/tbl_abc/rec_456", sha256: other }]))
      .toBe(stateRootV1([{ key: "row/tbl_abc/rec_456", sha256: other }, { key, sha256: forward }]));
  });

  it("orders canonical names by UTF-8 bytes rather than host locale", () => {
    expect(stateLeafHashV1("row/order", ["a_", "a-", "A", "a."].map(name => ({
      name, kind: "text" as const, value: name,
    })))).toBe("sha256:baa8881419e141f2089dfbd6e6db9d88a32bd94932af33abda1d6b231dbb0673");
  });

  it.each([
    [[{ name: "x", kind: "text", value: "a" }, { name: "x", kind: "text", value: "b" }], "duplicate field"],
    [[{ name: "x", kind: "integer", value: "01" }], "noncanonical integer"],
    [[{ name: "x", kind: "integer", value: "-0" }], "negative zero integer"],
    [[{ name: "x", kind: "integer", value: "9223372036854775808" }], "integer overflow"],
    [[{ name: "x", kind: "real", value: Number.NaN }], "non-finite real"],
    [[{ name: "x", kind: "text", value: "\ud800" }], "unpaired surrogate text"],
    [[{ name: "x", kind: "content", sha256: "sha256:no", bytes: "1" }], "malformed content hash"],
    [[{ name: "x", kind: "content", sha256: `sha256:${"11".repeat(32)}`, bytes: "01" }], "noncanonical byte count"],
    [[{ name: "x", kind: "bytes", value: new Uint8Array([1]) }], "raw attachment bytes"],
  ] as const)("fails closed for %s", (candidate, _reason) => {
    expect(() => stateLeafHashV1(key, candidate as unknown as StateLeafFieldV1[])).toThrow();
  });

  it("rejects malformed or duplicate leaf identities", () => {
    const valid = stateLeafHashV1(key, fields);
    expect(() => stateRootV1([{ key, sha256: valid }, { key, sha256: valid }])).toThrow();
    expect(() => stateRootV1([{ key: "", sha256: valid }])).toThrow();
    expect(() => stateRootV1([{ key, sha256: "sha256:no" }])).toThrow();
  });
});
