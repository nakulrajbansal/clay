import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openXlsxWorkbook } from "../src/worker/release-c/xlsx-adapter";
import { worksheetXml, xlsxFixture, zipFixture } from "./fixtures/xlsx-fixture";

function digest(bytes: ArrayBuffer): string {
  return `sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}`;
}

describe("Release C bounded XLSX adapter", () => {
  it("C-T-UNIT-002 enumerates workbook-order visibility and decodes scalar cell kinds", async () => {
    const source = xlsxFixture({
      sharedStrings: ["Shared"],
      sheets: [
        {
          name: "Current work",
          xml: worksheetXml(
            `<row r="1">`
            + `<c r="A1" t="s"><v>0</v></c>`
            + `<c r="B1" t="inlineStr"><is><t>Inline</t></is></c>`
            + `<c r="C1" t="b"><v>1</v></c>`
            + `<c r="D1"><v>42.5</v></c>`
            + `<c r="E1" t="e"><v>#DIV/0!</v></c>`
            + `</row>`,
            "A1:E1",
          ),
        },
        {
          name: "Archive",
          state: "hidden",
          xml: worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>Old</t></is></c></row>`),
        },
        {
          name: "Internal",
          state: "veryHidden",
          xml: worksheetXml(`<row r="1"><c r="A1"><v>9</v></c></row>`),
        },
      ],
    });

    const workbook = await openXlsxWorkbook(new Uint8Array(source));
    expect(workbook.sourceDigest).toBe(digest(source));
    expect(workbook.sheets).toEqual([
      { sheetId: "sheet_1", label: "Current work", visibility: "visible",
        range: { rows: 1, columns: 5 } },
      { sheetId: "sheet_2", label: "Archive", visibility: "hidden",
        range: { rows: 1, columns: 1 } },
      { sheetId: "sheet_3", label: "Internal", visibility: "very_hidden",
        range: { rows: 1, columns: 1 } },
    ]);
    expect(await workbook.readSheet("sheet_1")).toEqual([
      ["Shared", "Inline", "true", "42.5", "#DIV/0!"],
    ]);
  });

  it("C-FR-013 decodes inline rich text without appending phonetic guides", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Rich text", xml: worksheetXml(
        `<row r="1"><c r="A1" t="inlineStr"><is>`
        + `<t>Visible</t><rPh sb="0" eb="7"><t>PHONETIC</t></rPh>`
        + `<r><t> value</t></r></is></c></row>`,
      ) }],
    })));

    expect(await workbook.readSheet("sheet_1")).toEqual([["Visible value"]]);
  });

  it("C-FR-013 decodes shared rich text without appending phonetic guides", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sharedStringsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + `<si><t>Visible</t><rPh sb="0" eb="7"><t>PHONETIC</t></rPh>`
        + `<r><t> value</t></r></si></sst>`,
      sheets: [{ name: "Rich text", xml: worksheetXml(
        `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`,
      ) }],
    })));

    expect(await workbook.readSheet("sheet_1")).toEqual([["Visible value"]]);
  });

  it("C-NFR-013 rejects cells outside rows and non-increasing row ordinals", async () => {
    const malformedWorksheets = [
      worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`
        + `<c r="B1"><v>2</v></c>`,
        "A1:B1",
      ),
      worksheetXml(
        `<row r="2"><c r="A2"><v>2</v></c></row>`
        + `<row r="1"><c r="A1"><v>1</v></c></row>`,
        "A1:A2",
      ),
    ];

    for (const xml of malformedWorksheets) {
      await expect(openXlsxWorkbook(new Uint8Array(xlsxFixture({
        sheets: [{ name: "Rows", xml }],
      })))).rejects.toMatchObject({
        code: "E_IMPORT_XLSX_INVALID", stage: "parse",
      });
    }
  });

  it("C-NFR-013 rejects multiple cached values in one worksheet cell", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Rows", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v><v>2</v></c></row>`,
      ) }],
    })));

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects cached values outside a direct worksheet-cell child", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Rows", xml: worksheetXml(
        `<row r="1"><c r="A1"><ext><v>1</v></ext></c></row>`,
      ) }],
    })));

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects worksheet cells that reference a missing style", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Rows", xml: worksheetXml(
        `<row r="1"><c r="A1" s="2"><v>1</v></c></row>`,
      ) }],
    })));

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-FR-013 converts 1900 and 1904 date serials without locale or timezone drift", async () => {
    const dateCells = `<row r="1">`
      + `<c r="A1" s="1"><v>1</v></c>`
      + `<c r="B1" s="1"><v>59</v></c>`
      + `<c r="C1" s="1"><v>61</v></c>`
      + `<c r="D1" s="1"><v>61.5</v></c>`
      + `</row>`;
    const workbook1900 = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Dates", xml: worksheetXml(dateCells, "A1:D1") }],
    })));
    const workbook1904 = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      date1904: true,
      sheets: [{ name: "Dates", xml: worksheetXml(
        `<row r="1"><c r="A1" s="1"><v>0</v></c>`
        + `<c r="B1" s="1"><v>1.25</v></c></row>`, "A1:B1",
      ) }],
    })));

    expect(await workbook1900.readSheet("sheet_1")).toEqual([[
      "1900-01-01", "1900-02-28", "1900-03-01", "1900-03-01T12:00:00Z",
    ]]);
    expect(await workbook1904.readSheet("sheet_1")).toEqual([[
      "1904-01-01", "1904-01-02T06:00:00Z",
    ]]);
  });

  it("C-FR-013 rejects Excel's fictitious 1900-02-29 serial 60", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Dates", xml: worksheetXml(
        `<row r="1"><c r="A1" s="1"><v>60</v></c></row>`,
      ) }],
    })));

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID",
      stage: "parse",
    });
  });

  it("C-NFR-013 rejects external package relationships with a stable unsafe-input code", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      rootRelationshipsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
        + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid/private" TargetMode="External"/>`
        + `</Relationships>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_UNSAFE",
      stage: "parse",
    });
  });

  it("C-NFR-013 rejects lookalike office relationship type namespaces", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      rootRelationshipsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="urn:evil/officedocument" Target="xl/workbook.xml"/>`
        + `</Relationships>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects macro and embedded active-content parts before expansion", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      extraEntries: [{ name: "xl/vbaProject.bin", data: new Uint8Array([1, 2, 3]) }],
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_UNSAFE",
      stage: "acquire",
    });
  });

  it("C-NFR-013 rejects DTD and entity declarations in every XML package part", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      extraEntries: [{
        name: "customXml/item1.xml",
        data: `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY steal SYSTEM "file:///private">]><x>&steal;</x>`,
      }],
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_UNSAFE",
      stage: "parse",
    });
  });

  it("C-NFR-013 scans XML package-part extensions case-insensitively", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      extraEntries: [{
        name: "customXml/item1.XML",
        data: `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY steal SYSTEM "file:///private">]><x>&steal;</x>`,
      }],
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_UNSAFE", stage: "parse",
    });
  });

  it("C-FR-002 identifies encrypted OLE workbook containers as unsafe input", async () => {
    const encryptedPackage = new Uint8Array(512);
    encryptedPackage.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

    await expect(openXlsxWorkbook(encryptedPackage)).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_UNSAFE",
      stage: "acquire",
    });
  });

  it("C-NFR-013 rejects ZIP encryption flags before expanding an entry", async () => {
    const source = zipFixture([{
      name: "[Content_Types].xml",
      data: "<Types/>",
      flags: 0x0801,
    }]);

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_UNSAFE",
      stage: "acquire",
    });
  });

  it("C-FR-002 accepts standard deflate compression-level ZIP flags", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      zipFlags: 0x0802,
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
    })));

    expect(await workbook.readSheet("sheet_1")).toEqual([["1"]]);
  });

  it("C-FR-053 exposes only cached formula scalars and rejects a missing cache", async () => {
    const cached = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Formula", xml: worksheetXml(
        `<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>`,
      ) }],
    })));
    const rows = await cached.readSheet("sheet_1");
    expect(rows).toEqual([["2"]]);
    expect(JSON.stringify(rows)).not.toContain("1+1");

    const missing = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Formula", xml: worksheetXml(
        `<row r="1"><c r="A1"><f>PRIVATE_FORMULA_SENTINEL</f></c></row>`,
      ) }],
    })));
    await expect(missing.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_FORMULA",
      stage: "parse",
    });
  });

  it("C-NFR-013 rejects duplicate normalized ZIP member names during preflight", async () => {
    const source = zipFixture([
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "XL/WORKBOOK.XML", data: "<workbook/>" },
    ]);

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID",
      stage: "acquire",
    });
  });

  it("C-FR-004 enforces the hard 2,000-entry ZIP ceiling before expansion", async () => {
    const source = zipFixture(Array.from({ length: 2_001 }, (_unused, index) => ({
      name: `parts/p${index}.xml`,
      data: "<x/>",
      method: "store" as const,
    })));

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_SOURCE_LIMIT",
      stage: "acquire",
      limit: 2_000,
      actual: 2_001,
    });
  });

  it("C-FR-004 rejects a declared expanded package above 100 MiB without inflating it", async () => {
    const expanded = 100 * 1024 * 1024 + 1;
    const source = zipFixture([{
      name: "[Content_Types].xml",
      data: "<Types/>",
      declaredExpandedSize: expanded,
    }]);

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_DECODED_LIMIT",
      stage: "acquire",
      limit: 100 * 1024 * 1024,
      actual: expanded,
    });
  });

  it("C-FR-004 rejects the compression-ratio ceiling at its one-MiB boundary before inflate", async () => {
    const source = zipFixture([{
      name: "[Content_Types].xml",
      data: "<Types/>",
      declaredExpandedSize: 1024 * 1024,
    }]);

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "acquire",
    });
  });

  it("C-FR-004 rejects sparse worksheet dimensions above 5,001 source rows or 20 columns", async () => {
    const tooManyRows = xlsxFixture({
      sheets: [{ name: "Rows", xml: worksheetXml("", "A1:A5002") }],
    });
    const tooManyColumns = xlsxFixture({
      sheets: [{ name: "Columns", xml: worksheetXml("", "A1:U1") }],
    });

    await expect(openXlsxWorkbook(new Uint8Array(tooManyRows))).rejects.toMatchObject({
      code: "E_IMPORT_ROW_LIMIT", stage: "parse", limit: 5_001, actual: 5_002,
    });
    await expect(openXlsxWorkbook(new Uint8Array(tooManyColumns))).rejects.toMatchObject({
      code: "E_IMPORT_COLUMN_LIMIT", stage: "parse", limit: 20, actual: 21,
    });
  });

  it("C-FR-004 aborts parsing when the hard eight-second deadline is crossed", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
    });
    let current = 0;

    await expect(openXlsxWorkbook(new Uint8Array(source), {
      now: () => {
        const value = current;
        current += 1_000;
        return value;
      },
    })).rejects.toMatchObject({
      code: "E_IMPORT_TIME_LIMIT", stage: "parse", limit: 8_000,
    });
  });

  it("C-NFR-013 rejects overlong XML token names before scanning unbounded input", async () => {
    const longName = `x${"a".repeat(1_024)}`;
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row><${longName}/>`
      ) }],
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects overlong XML attribute values", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`
        + `<ignored value="${"x".repeat(64 * 1024 + 1)}"/>`,
      ) }],
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-FR-004 checks the deadline while advancing across adversarial XML tokens", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`
        + Array.from({ length: 400 }, () => `<ignored/>`).join(""),
      ) }],
    });
    let checks = 0;

    await expect(openXlsxWorkbook(new Uint8Array(source), {
      now: () => ++checks > 100 ? 8_001 : 0,
    })).rejects.toMatchObject({
      code: "E_IMPORT_TIME_LIMIT", stage: "parse", limit: 8_000,
    });
  });

  it("C-FR-004 checks the deadline while decoding dense XML entities", async () => {
    let reading = false;
    let checks = 0;
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sharedStringsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + `<si><t>${"&amp;".repeat(400)}</t></si></sst>`,
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`,
      ) }],
    })), {
      now: () => reading && ++checks > 150 ? 8_001 : 0,
    });
    reading = true;

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_TIME_LIMIT", stage: "parse", limit: 8_000,
    });
  });

  it("C-FR-004 does not turn a dimension-only empty worksheet into a blank data row", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Empty", xml: worksheetXml("", "A1") }],
    })));

    expect(workbook.sheets[0]?.range).toEqual({ rows: 0, columns: 0 });
    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_EMPTY_SOURCE", stage: "parse",
    });
  });

  it("C-NFR-013 rejects foreign-namespace elements that spoof worksheet cell tags", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>`
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:evil="urn:evil">`
      + `<dimension ref="A1:B1"/><sheetData><row r="1">`
      + `<c r="A1" t="inlineStr"><is><t>safe</t></is></c>`
      + `<evil:c r="B1"><evil:v>PRIVATE_NAMESPACE_SENTINEL</evil:v></evil:c>`
      + `</row></sheetData></worksheet>`;
    const source = xlsxFixture({ sheets: [{ name: "Data", xml }] });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects foreign-namespace elements that spoof workbook metadata", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      workbookXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
        + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
        + `xmlns:evil="urn:evil"><evil:workbookPr date1904="1"/><sheets>`
        + `<sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects workbook metadata under a spoofed XML root", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      workbookXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<evil xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
        + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
        + `<workbookPr/><sheets><sheet name="Data" sheetId="1" r:id="rId1"/>`
        + `</sheets></evil>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects worksheet, shared-string, and style data under spoofed roots", async () => {
    const worksheetSource = xlsxFixture({
      sheets: [{ name: "Data", xml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<evil xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + `<dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row>`
        + `</sheetData></evil>` }],
    });
    await expect(openXlsxWorkbook(new Uint8Array(worksheetSource))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });

    const sharedWorkbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sharedStringsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<evil xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + `<si><t>spoofed</t></si></evil>`,
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`,
      ) }],
    })));
    await expect(sharedWorkbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });

    const styledWorkbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      stylesXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<evil xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + `<cellXfs count="1"><xf numFmtId="0"/></cellXfs></evil>`,
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
    })));
    await expect(styledWorkbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects duplicate expanded XML attributes", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      workbookXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
        + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
        + `xmlns:r2="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
        + `<sheets><sheet name="Data" sheetId="1" r:id="rId1" r2:id="rId1"/>`
        + `</sheets></workbook>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects foreign-namespace elements that spoof shared strings", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sharedStringsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:evil="urn:evil">`
        + `<evil:si><evil:t>PRIVATE_NAMESPACE_SENTINEL</evil:t></evil:si></sst>`,
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`,
      ) }],
    })));

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects foreign-namespace elements that spoof cell styles", async () => {
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      stylesXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:evil="urn:evil">`
        + `<evil:cellXfs count="1"><evil:xf numFmtId="14"/></evil:cellXfs></styleSheet>`,
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
    })));

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects foreign-namespace elements that spoof cached cell values", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>`
      + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:evil="urn:evil">`
      + `<dimension ref="A1"/><sheetData><row r="1">`
      + `<c r="A1"><evil:v>2</evil:v></c>`
      + `</row></sheetData></worksheet>`;
    const workbook = await openXlsxWorkbook(new Uint8Array(xlsxFixture({
      sheets: [{ name: "Data", xml }],
    })));

    await expect(workbook.readSheet("sheet_1")).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects a relationship list under a spoofed XML root", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      rootRelationshipsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<evil xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
        + `</evil>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects foreign-namespace elements that spoof package relationships", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      rootRelationshipsXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:evil="urn:evil">`
        + `<evil:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
        + `</Relationships>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects content types under a spoofed XML root", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      contentTypesXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<evil xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
        + `</evil>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });

  it("C-NFR-013 rejects foreign-namespace elements that spoof content-type declarations", async () => {
    const source = xlsxFixture({
      sheets: [{ name: "Data", xml: worksheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>`,
      ) }],
      contentTypesXml: `<?xml version="1.0" encoding="UTF-8"?>`
        + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:evil="urn:evil">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
        + `<Default Extension="xml" ContentType="application/xml"/>`
        + `<evil:Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
        + `</Types>`,
    });

    await expect(openXlsxWorkbook(new Uint8Array(source))).rejects.toMatchObject({
      code: "E_IMPORT_XLSX_INVALID", stage: "parse",
    });
  });
});
