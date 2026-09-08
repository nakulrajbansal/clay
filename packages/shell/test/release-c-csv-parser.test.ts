import { describe, expect, it } from "vitest";
import {
  ImportParserError,
  parseDelimitedSource,
} from "../src/worker/release-c/csv-parser";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("Release C delimited parser", () => {
  it("C-T-UNIT-001 parses UTF-8 BOM RFC-4180 records and digests the exact source bytes", async () => {
    const body = utf8('Name,Note\r\nAlice,"line one\r\nline two"\r\nBob,"a ""quote"""\r\n');
    const bytes = new Uint8Array(body.byteLength + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);

    const parsed = await parseDelimitedSource({ kind: "csv", bytes });

    expect(parsed).toMatchObject({
      delimiter: ",",
      columns: 2,
      decodedCellBytes: 43,
      sourceDigest: "sha256:9661e648dec2ad9862c04d45a543d5f79d5376862726276493155aa9e59ac75f",
    });
    expect(parsed.rows).toEqual([
      ["Name", "Note"],
      ["Alice", "line one\r\nline two"],
      ["Bob", 'a "quote"'],
    ]);
  });

  it("C-FR-004 rejects column limit+1 instead of truncating", async () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `c${index + 1}`).join(",");
    expect((await parseDelimitedSource({ kind: "csv", bytes: utf8(twenty) })).columns)
      .toBe(20);

    const twentyOne = `${twenty},private-column-21`;
    await expect(parseDelimitedSource({ kind: "csv", bytes: utf8(twentyOne) }))
      .rejects.toMatchObject({
        name: "ImportParserError",
        code: "E_IMPORT_COLUMN_LIMIT",
        stage: "parse",
        row: 1,
        limit: 20,
        actual: 21,
      } satisfies Partial<ImportParserError>);
  });

  it("C-FR-004 returns header plus 5,000 rows and rejects row limit+1 without slicing", async () => {
    const atLimit = ["Header", ...Array.from({ length: 5_000 }, (_, index) => String(index))]
      .join("\n");
    const parsed = await parseDelimitedSource({ kind: "csv", bytes: utf8(atLimit) });
    expect(parsed.rows).toHaveLength(5_001);
    expect(parsed.rows[5_000]).toEqual(["4999"]);

    const overLimit = `${atLimit}\nprivate-row-5001`;
    await expect(parseDelimitedSource({ kind: "csv", bytes: utf8(overLimit) }))
      .rejects.toMatchObject({
        code: "E_IMPORT_ROW_LIMIT",
        stage: "parse",
        limit: 5_001,
        actual: 5_002,
      } satisfies Partial<ImportParserError>);
  });

  it("C-FR-004 enforces the decoded 16 KiB cell bound with coordinates", async () => {
    const atLimit = "x".repeat(16 * 1024);
    expect((await parseDelimitedSource({ kind: "csv", bytes: utf8(atLimit) }))
      .rows[0]?.[0]).toHaveLength(16 * 1024);

    const overLimit = `${atLimit}SENSITIVE`;
    await expect(parseDelimitedSource({ kind: "csv", bytes: utf8(overLimit) }))
      .rejects.toMatchObject({
        code: "E_IMPORT_CELL_LIMIT",
        stage: "parse",
        row: 1,
        column: 1,
        limit: 16 * 1024,
        actual: 16 * 1024 + 9,
      } satisfies Partial<ImportParserError>);
  });

  it("C-FR-004 enforces the cumulative decoded-cell byte ceiling", async () => {
    await expect(parseDelimitedSource(
      { kind: "csv", bytes: utf8("A,B\ncc,dd") },
      { decodedCellsByteLimitForTest: 5 },
    )).rejects.toMatchObject({
      code: "E_IMPORT_DECODED_LIMIT",
      stage: "parse",
      limit: 5,
      actual: 6,
    } satisfies Partial<ImportParserError>);
  });

  it.each([
    ["csv", 16 * 1024 * 1024],
    ["paste", 8 * 1024 * 1024],
  ] as const)("C-FR-004 rejects %s acquisition byte limit+1 before decode", async (kind, limit) => {
    const bytes = new Uint8Array(limit + 1);
    await expect(parseDelimitedSource({ kind, bytes })).rejects.toMatchObject({
      code: "E_IMPORT_SOURCE_LIMIT",
      stage: "acquire",
      limit,
      actual: limit + 1,
    } satisfies Partial<ImportParserError>);
  });

  it("C-NFR-003 rejects invalid UTF-8 with a stable safe decode error", async () => {
    await expect(parseDelimitedSource({
      kind: "csv", bytes: new Uint8Array([0x63, 0x33, 0xc3, 0x28]),
    })).rejects.toMatchObject({
      name: "ImportParserError",
      code: "E_IMPORT_UTF8",
      stage: "decode",
    } satisfies Partial<ImportParserError>);
  });

  it.each([
    'Name\n"PRIVATE_SENTINEL',
    'Name\npre"PRIVATE_SENTINEL',
    'Name\n"PRIVATE_SENTINEL"tail',
  ])("C-NFR-014 maps malformed CSV to a value-free stable syntax error", async malformed => {
    let failure: unknown;
    try {
      await parseDelimitedSource({ kind: "csv", bytes: utf8(malformed) });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ImportParserError",
      code: "E_IMPORT_CSV_SYNTAX",
      stage: "parse",
    } satisfies Partial<ImportParserError>);
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL");
    expect((failure as Error).message).not.toContain("PRIVATE_SENTINEL");
  });

  it.each([
    ["A,B\nonly-one", 1],
    ["A,B\none,two,private-third", 3],
  ] as const)("C-NFR-003 rejects ragged rows rather than padding or dropping cells", async (text, actual) => {
    await expect(parseDelimitedSource({ kind: "csv", bytes: utf8(text) }))
      .rejects.toMatchObject({
        code: "E_IMPORT_RAGGED_ROW",
        stage: "parse",
        row: 2,
        limit: 2,
        actual,
      } satisfies Partial<ImportParserError>);
  });

  it("C-NFR-003 rejects NUL/control input with bounded coordinates", async () => {
    await expect(parseDelimitedSource({
      kind: "csv", bytes: utf8("A,B\nprivate\u0000value,ok"),
    })).rejects.toMatchObject({
      code: "E_IMPORT_CONTROL_CHARACTER",
      stage: "parse",
      row: 2,
      column: 1,
    } satisfies Partial<ImportParserError>);
  });

  it("C-FR-002 deterministically prefers tab on a paste delimiter tie", async () => {
    const parsed = await parseDelimitedSource({
      kind: "paste", bytes: utf8("A,B\tC\n1,2\t3"),
    });
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.rows).toEqual([
      ["A,B", "C"],
      ["1,2", "3"],
    ]);
  });

  it("C-NFR-003 aborts at the explicit 8 s parse deadline using an injectable monotonic clock", async () => {
    const ticks = [0, 8_001];
    await expect(parseDelimitedSource(
      { kind: "csv", bytes: utf8("A\nB") },
      { now: () => ticks.shift() ?? 8_001 },
    )).rejects.toMatchObject({
      code: "E_IMPORT_TIME_LIMIT",
      stage: "parse",
      limit: 8_000,
      actual: 8_001,
    } satisfies Partial<ImportParserError>);
  });

  it.each([
    new Uint8Array(),
    new Uint8Array([0xef, 0xbb, 0xbf]),
  ])("C-FR-028 rejects an empty decoded source before opening a session", async bytes => {
    await expect(parseDelimitedSource({ kind: "csv", bytes })).rejects.toMatchObject({
      code: "E_IMPORT_EMPTY_SOURCE",
      stage: "parse",
    } satisfies Partial<ImportParserError>);
  });
});
