import { deflateRawSync } from "node:zlib";

export type ZipFixtureEntry = {
  name: string;
  data: string | Uint8Array;
  method?: "store" | "deflate";
  flags?: number;
  declaredCompressedSize?: number;
  declaredExpandedSize?: number;
};

export type XlsxSheetFixture = {
  name: string;
  state?: "visible" | "hidden" | "veryHidden";
  xml: string;
};

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function fixtureCrc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data)
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Small deterministic ZIP writer used only by hostile OOXML tests. */
export function zipFixture(entries: readonly ZipFixtureEntry[]): ArrayBuffer {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const expanded = bytes(entry.data);
    const method = entry.method === "store" ? 0 : 8;
    const compressed = method === 0 ? expanded : new Uint8Array(deflateRawSync(expanded));
    const flags = entry.flags ?? 0x0800;
    const crc = fixtureCrc32(expanded);
    const compressedSize = entry.declaredCompressedSize ?? compressed.byteLength;
    const expandedSize = entry.declaredExpandedSize ?? expanded.byteLength;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, compressedSize, true);
    local.setUint32(22, expandedSize, true);
    local.setUint16(26, name.byteLength, true);
    localParts.push(new Uint8Array(local.buffer), name, compressed);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, flags, true);
    central.setUint16(10, method, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, compressedSize, true);
    central.setUint32(24, expandedSize, true);
    central.setUint16(28, name.byteLength, true);
    central.setUint32(42, localOffset, true);
    centralParts.push(new Uint8Array(central.buffer), name);
    localOffset += 30 + name.byteLength + compressed.byteLength;
  }

  const centralDirectory = concatenate(centralParts);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralDirectory.byteLength, true);
  eocd.setUint32(16, localOffset, true);
  const output = concatenate([...localParts, centralDirectory, new Uint8Array(eocd.buffer)]);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function worksheetXml(body: string, dimension = "A1"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<dimension ref="${attribute(dimension)}"/><sheetData>${body}</sheetData></worksheet>`;
}

export function xlsxFixture(input: {
  sheets: readonly XlsxSheetFixture[];
  sharedStrings?: readonly string[];
  sharedStringsXml?: string;
  date1904?: boolean;
  stylesXml?: string;
  extraEntries?: readonly ZipFixtureEntry[];
  rootRelationshipsXml?: string;
  workbookRelationshipsXml?: string;
  workbookXml?: string;
  contentTypesXml?: string;
  zipFlags?: number;
}): ArrayBuffer {
  const sharedStrings = input.sharedStrings ?? [];
  const sheetOverrides = input.sheets.map((_sheet, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const contentTypes = input.contentTypesXml ?? `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + sheetOverrides
    + `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + `</Types>`;
  const rootRelationships = input.rootRelationshipsXml ?? `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;
  const workbook = input.workbookXml ?? `<?xml version="1.0" encoding="UTF-8"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<workbookPr${input.date1904 ? ' date1904="1"' : ""}/><sheets>`
    + input.sheets.map((sheet, index) => `<sheet name="${attribute(sheet.name)}" sheetId="${index + 1}"`
      + `${sheet.state && sheet.state !== "visible" ? ` state="${sheet.state}"` : ""} r:id="rId${index + 1}"/>`).join("")
    + `</sheets></workbook>`;
  const workbookRelationships = input.workbookRelationshipsXml
    ?? `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + input.sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" `
        + `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" `
        + `Target="worksheets/sheet${index + 1}.xml"/>`).join("")
      + `<Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`
      + `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + `</Relationships>`;
  const shared = input.sharedStringsXml ?? `<?xml version="1.0" encoding="UTF-8"?>`
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`
    + sharedStrings.map(value => `<si><t>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</t></si>`).join("")
    + `</sst>`;
  const styles = input.stylesXml ?? `<?xml version="1.0" encoding="UTF-8"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

  const entries: ZipFixtureEntry[] = [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRelationships },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRelationships },
    { name: "xl/sharedStrings.xml", data: shared },
    { name: "xl/styles.xml", data: styles },
    ...input.sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet.xml,
    })),
    ...(input.extraEntries ?? []),
  ];
  return zipFixture(entries.map(entry => entry.flags === undefined && input.zipFlags !== undefined
    ? { ...entry, flags: input.zipFlags } : entry));
}
