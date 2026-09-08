import {
  IMPORT_ACQUISITION_LIMITS,
  type ImportSourceDescriptor,
} from "@clay/kernel/import-contracts";
import { ImportParserError } from "./csv-parser";

/**
 * Dependency-free Release C OOXML reader. It lives behind the dedicated import
 * worker and deliberately implements only the scalar worksheet subset Clay can
 * stage. ZIP metadata is validated in full before the first member is expanded.
 */

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_DEFLATE_OPTION_FLAGS = 0x0006;
const ZIP_ALLOWED_FLAGS = ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG | ZIP_DEFLATE_OPTION_FLAGS;
const MAX_XML_DEPTH = 64;
const MAX_XML_ATTRIBUTES = 64;
const MAX_XML_NAME_LENGTH = 128;
const MAX_XML_ATTRIBUTE_VALUE_LENGTH = 64 * 1024;
const MAX_COMPRESSION_RATIO = 1_000;
const MAX_SOURCE_ROWS = IMPORT_ACQUISITION_LIMITS.maxDataRows + 1;
const MAX_WORKSHEET_CELLS = MAX_SOURCE_ROWS * IMPORT_ACQUISITION_LIMITS.maxMappedColumns;
const MAX_CELL_STYLES = 65_536;
const SPREADSHEET_XML_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://purl.oclc.org/ooxml/package/relationships",
]);
const CONTENT_TYPES_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/package/2006/content-types",
  "http://purl.oclc.org/ooxml/package/content-types",
]);
const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const XML_DECLARATION_ENCODING = /<\?xml\s[^>]*encoding\s*=\s*["']([^"']+)["'][^>]*\?>/i;
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const NUMBER_TEXT = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[Ee][+-]?[0-9]+)?$/;
const CELL_REFERENCE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$/;
const RANGE_REFERENCE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]*))?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type SheetDescriptor = ImportSourceDescriptor["sheets"][number];

type ZipEntry = {
  name: string;
  method: 0 | 8;
  flags: number;
  crc: number;
  compressedSize: number;
  expandedSize: number;
  dataStart: number;
  dataEnd: number;
};

type Relationship = {
  id: string;
  type: string;
  target: string;
};

type SheetInfo = {
  descriptor: SheetDescriptor;
  part: string;
};

type Bounds = {
  minRow: number;
  maxRow: number;
  minColumn: number;
  maxColumn: number;
};

type XmlHandlers = {
  start?(
    name: string,
    attributes: ReadonlyMap<string, string>,
    namespace: string | null,
    namespaces: ReadonlyMap<string, string>,
  ): void;
  text?(value: string): void;
  end?(name: string, namespace: string | null): void;
};

type XmlStackEntry = {
  qualifiedName: string;
  namespace: string | null;
  namespaces: ReadonlyMap<string, string>;
};

export type XlsxAdapterEnvironment = {
  now?: () => number;
};

export type OpenedXlsxWorkbook = {
  readonly sourceDigest: `sha256:${string}`;
  readonly sheets: readonly SheetDescriptor[];
  readSheet(sheetId: string): Promise<string[][]>;
};

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

function xlsxFailure(stage: "acquire" | "decode" | "parse", detail: {
  limit?: number;
  actual?: number;
  row?: number;
  column?: number;
} = {}): ImportParserError {
  return new ImportParserError("E_IMPORT_XLSX_INVALID", stage, detail);
}

function limitFailure(
  code: "E_IMPORT_SOURCE_LIMIT" | "E_IMPORT_ROW_LIMIT" | "E_IMPORT_COLUMN_LIMIT"
    | "E_IMPORT_CELL_LIMIT" | "E_IMPORT_DECODED_LIMIT" | "E_IMPORT_TIME_LIMIT",
  stage: "acquire" | "decode" | "parse",
  detail: { limit: number; actual: number; row?: number; column?: number },
): ImportParserError {
  return new ImportParserError(code, stage, detail);
}

function deadline(environment: XlsxAdapterEnvironment): () => void {
  const now = environment.now ?? (() => performance.now());
  const startedAt = now();
  return (): void => {
    const elapsed = Math.max(0, Math.ceil(now() - startedAt));
    if (elapsed > IMPORT_ACQUISITION_LIMITS.maxParseMilliseconds)
      throw limitFailure("E_IMPORT_TIME_LIMIT", "parse", {
        limit: IMPORT_ACQUISITION_LIMITS.maxParseMilliseconds,
        actual: elapsed,
      });
  };
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) throw xlsxFailure("acquire");
  return result;
}

function findEndRecord(bytes: Uint8Array, view: DataView): number {
  const minimum = Math.max(0, bytes.byteLength - 22 - 65_535);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE)
      return offset;
  }
  throw xlsxFailure("acquire");
}

function decodeEntryName(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw xlsxFailure("decode");
  }
}

function normalizedPartName(value: string): string {
  if (value.length < 1 || value.length > 240 || value.includes("\\")
      || value.startsWith("/") || value.endsWith("/") || value.includes("\u0000")
      || !/^[\x20-\x7e]+$/.test(value)) throw xlsxFailure("acquire");
  const segments = value.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === ".."))
    throw xlsxFailure("acquire");
  return segments.join("/");
}

function scanExtraFields(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) throw xlsxFailure("acquire");
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + size > bytes.byteLength || id === 0x0001 || id === 0x0017)
      throw xlsxFailure("acquire");
    offset += size;
  }
}

function parseZipDirectory(bytes: Uint8Array, assertWithinDeadline: () => void): Map<string, ZipEntry> {
  if (bytes.byteLength > IMPORT_ACQUISITION_LIMITS.maxCompressedXlsxBytes)
    throw limitFailure("E_IMPORT_SOURCE_LIMIT", "acquire", {
      limit: IMPORT_ACQUISITION_LIMITS.maxCompressedXlsxBytes,
      actual: bytes.byteLength,
    });
  if (bytes.byteLength >= 8
      && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
        .every((byte, index) => bytes[index] === byte))
    throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "acquire");
  if (bytes.byteLength < 22) throw xlsxFailure("acquire");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(bytes, view);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const entries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  const commentLength = view.getUint16(end + 20, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries
      || end + 22 + commentLength !== bytes.byteLength
      || centralOffset === 0xffffffff || centralSize === 0xffffffff
      || checkedAdd(centralOffset, centralSize) !== end) throw xlsxFailure("acquire");
  if (entries < 1 || entries > IMPORT_ACQUISITION_LIMITS.maxXlsxEntries)
    throw limitFailure("E_IMPORT_SOURCE_LIMIT", "acquire", {
      limit: IMPORT_ACQUISITION_LIMITS.maxXlsxEntries,
      actual: entries,
    });

  const result = new Map<string, ZipEntry>();
  const duplicateNames = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  let expandedTotal = 0;
  let position = centralOffset;
  for (let index = 0; index < entries; index++) {
    if ((index & 0x1f) === 0) assertWithinDeadline();
    if (position + 46 > end || view.getUint32(position, true) !== CENTRAL_FILE_SIGNATURE)
      throw xlsxFailure("acquire");
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const crc = view.getUint32(position + 16, true);
    const compressedSize = view.getUint32(position + 20, true);
    const expandedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const entryCommentLength = view.getUint16(position + 32, true);
    const startDisk = view.getUint16(position + 34, true);
    const externalAttributes = view.getUint32(position + 38, true);
    const localOffset = view.getUint32(position + 42, true);
    const centralEnd = checkedAdd(position + 46,
      checkedAdd(nameLength, checkedAdd(extraLength, entryCommentLength)));
    if ((flags & (0x0001 | 0x0040 | 0x2000)) !== 0)
      throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "acquire");
    if (centralEnd > end || startDisk !== 0 || localOffset === 0xffffffff
        || compressedSize === 0xffffffff || expandedSize === 0xffffffff
        || (flags & ~ZIP_ALLOWED_FLAGS) !== 0 || (method !== 0 && method !== 8)
        || (method === 0 && (flags & ZIP_DEFLATE_OPTION_FLAGS) !== 0)
        || (method === 0 && compressedSize !== expandedSize)
        || (externalAttributes & 0xf0000000) === 0xa0000000) throw xlsxFailure("acquire");
    scanExtraFields(bytes.subarray(position + 46 + nameLength,
      position + 46 + nameLength + extraLength));
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    if ((flags & ZIP_UTF8_FLAG) === 0 && nameBytes.some(byte => byte > 0x7f))
      throw xlsxFailure("decode");
    const name = normalizedPartName(decodeEntryName(nameBytes));
    const duplicateKey = name.toLowerCase();
    if (duplicateNames.has(duplicateKey)) throw xlsxFailure("acquire");
    duplicateNames.add(duplicateKey);
    if (localOffset + 30 > centralOffset
        || view.getUint32(localOffset, true) !== LOCAL_FILE_SIGNATURE) throw xlsxFailure("acquire");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localExpandedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localNameEnd = checkedAdd(localNameStart, localNameLength);
    const dataStart = checkedAdd(localNameEnd, localExtraLength);
    const dataEnd = checkedAdd(dataStart, compressedSize);
    if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset
        || localNameLength !== nameLength) throw xlsxFailure("acquire");
    scanExtraFields(bytes.subarray(localNameEnd, dataStart));
    const localName = bytes.subarray(localNameStart, localNameEnd);
    if (localName.some((byte, byteIndex) => byte !== nameBytes[byteIndex]))
      throw xlsxFailure("acquire");
    const descriptorMode = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
    if ((!descriptorMode && (localCrc !== crc || localCompressedSize !== compressedSize
          || localExpandedSize !== expandedSize))
        || (descriptorMode && localCrc !== 0 && localCrc !== crc)
        || (descriptorMode && localCompressedSize !== 0
          && localCompressedSize !== compressedSize)
        || (descriptorMode && localExpandedSize !== 0 && localExpandedSize !== expandedSize))
      throw xlsxFailure("acquire");
    let localEnd = dataEnd;
    if (descriptorMode) {
      let descriptor = dataEnd;
      if (descriptor + 4 <= centralOffset
          && view.getUint32(descriptor, true) === DATA_DESCRIPTOR_SIGNATURE) descriptor += 4;
      if (descriptor + 12 > centralOffset || view.getUint32(descriptor, true) !== crc
          || view.getUint32(descriptor + 4, true) !== compressedSize
          || view.getUint32(descriptor + 8, true) !== expandedSize) throw xlsxFailure("acquire");
      localEnd = descriptor + 12;
    }
    expandedTotal = checkedAdd(expandedTotal, expandedSize);
    if (expandedTotal > IMPORT_ACQUISITION_LIMITS.maxExpandedXlsxBytes)
      throw limitFailure("E_IMPORT_DECODED_LIMIT", "acquire", {
        limit: IMPORT_ACQUISITION_LIMITS.maxExpandedXlsxBytes,
        actual: expandedTotal,
      });
    if (expandedSize >= 1024 * 1024 && (compressedSize === 0
        || expandedSize / compressedSize > MAX_COMPRESSION_RATIO)) throw xlsxFailure("acquire");
    result.set(name, {
      name, method: method as 0 | 8, flags, crc, compressedSize, expandedSize, dataStart, dataEnd,
    });
    localRanges.push({ start: localOffset, end: localEnd });
    position = centralEnd;
  }
  if (position !== end) throw xlsxFailure("acquire");
  localRanges.sort((left, right) => left.start - right.start);
  let priorEnd = 0;
  for (const range of localRanges) {
    if (range.start !== priorEnd) throw xlsxFailure("acquire");
    priorEnd = range.end;
  }
  if (priorEnd !== centralOffset) throw xlsxFailure("acquire");
  return result;
}

function crc32(data: Uint8Array, assertWithinDeadline: () => void): number {
  let value = 0xffffffff;
  for (let index = 0; index < data.byteLength; index++) {
    if ((index & 0xffff) === 0) assertWithinDeadline();
    value = CRC_TABLE[(value ^ data[index]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function expandEntry(
  source: Uint8Array,
  entry: ZipEntry,
  assertWithinDeadline: () => void,
): Promise<Uint8Array> {
  assertWithinDeadline();
  const compressed = source.subarray(entry.dataStart, entry.dataEnd);
  let output: Uint8Array;
  if (entry.method === 0) {
    output = compressed.slice();
  } else {
    if (typeof DecompressionStream !== "function") throw xlsxFailure("decode");
    const stream = new Blob([compressed.slice().buffer]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    output = new Uint8Array(entry.expandedSize);
    let offset = 0;
    try {
      while (true) {
        assertWithinDeadline();
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.byteLength > output.byteLength) {
          await reader.cancel();
          throw xlsxFailure("decode");
        }
        output.set(next.value, offset);
        offset += next.value.byteLength;
      }
      if (offset !== output.byteLength) throw xlsxFailure("decode");
    } catch (error) {
      if (error instanceof ImportParserError) throw error;
      throw xlsxFailure("decode");
    } finally {
      reader.releaseLock();
    }
  }
  if (output.byteLength !== entry.expandedSize
      || crc32(output, assertWithinDeadline) !== entry.crc) throw xlsxFailure("decode");
  return output;
}

function xmlText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw xlsxFailure("decode");
  }
  const declared = XML_DECLARATION_ENCODING.exec(text)?.[1]?.toLowerCase();
  if (declared && declared !== "utf-8" && declared !== "utf8") throw xlsxFailure("decode");
  if (/<!\s*(?:doctype|entity)\b/i.test(text))
    throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "parse");
  return text;
}

function validXmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function decodeXmlEntities(value: string, assertWithinDeadline: () => void): string {
  if (!value.includes("&")) return value;
  let result = "";
  let offset = 0;
  while (offset < value.length) {
    assertWithinDeadline();
    const ampersand = value.indexOf("&", offset);
    if (ampersand < 0) return result + value.slice(offset);
    result += value.slice(offset, ampersand);
    const semicolon = value.indexOf(";", ampersand + 1);
    if (semicolon < 0 || semicolon - ampersand > 12) throw xlsxFailure("parse");
    const entity = value.slice(ampersand + 1, semicolon);
    const named: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    };
    if (Object.hasOwn(named, entity)) result += named[entity]!;
    else {
      const hex = entity.startsWith("#x") || entity.startsWith("#X");
      const decimal = entity.startsWith("#") && !hex;
      if (!hex && !decimal) throw xlsxFailure("parse");
      const digits = entity.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) throw xlsxFailure("parse");
      const codePoint = Number.parseInt(digits, hex ? 16 : 10);
      if (!validXmlCodePoint(codePoint)) throw xlsxFailure("parse");
      result += String.fromCodePoint(codePoint);
    }
    offset = semicolon + 1;
  }
  return result;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function namespacedAttribute(
  attributes: ReadonlyMap<string, string>,
  namespaces: ReadonlyMap<string, string>,
  wantedLocalName: string,
  acceptedNamespaces: ReadonlySet<string>,
): string | undefined {
  for (const [qualifiedName, value] of attributes) {
    const colon = qualifiedName.indexOf(":");
    if (colon < 1 || localName(qualifiedName) !== wantedLocalName) continue;
    if (acceptedNamespaces.has(namespaces.get(qualifiedName.slice(0, colon)) ?? "")) return value;
  }
  return undefined;
}

function hasOfficeRelationshipType(type: string, suffix: string): boolean {
  const foldedSuffix = suffix.toLowerCase();
  for (const namespace of OFFICE_RELATIONSHIP_NAMESPACES) {
    if (type.startsWith(`${namespace}/`)
        && type.slice(namespace.length).toLowerCase() === foldedSuffix) return true;
  }
  return false;
}

function xmlNameAt(text: string, start: number): { name: string; end: number } {
  let end = start;
  while (end < text.length && /[A-Za-z0-9_.:-]/.test(text[end]!)) {
    if (end - start >= MAX_XML_NAME_LENGTH) throw xlsxFailure("parse");
    end++;
  }
  const name = text.slice(start, end);
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) throw xlsxFailure("parse");
  return { name, end };
}

function parseXml(text: string, handlers: XmlHandlers, assertWithinDeadline: () => void): void {
  const stack: XmlStackEntry[] = [];
  let rootElements = 0;
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const qualifiedPrefix = (name: string): string => {
    const colon = name.indexOf(":");
    if (colon !== name.lastIndexOf(":")) throw xlsxFailure("parse");
    return colon < 0 ? "" : name.slice(0, colon);
  };
  while (offset < text.length) {
    assertWithinDeadline();
    const open = text.indexOf("<", offset);
    if (open < 0) {
      const tail = text.slice(offset);
      if (stack.length > 0 && tail.length > 0)
        handlers.text?.(decodeXmlEntities(tail, assertWithinDeadline));
      else if (tail.trim().length > 0) throw xlsxFailure("parse");
      offset = text.length;
      break;
    }
    if (open > offset) {
      const between = text.slice(offset, open);
      if (stack.length > 0) handlers.text?.(decodeXmlEntities(between, assertWithinDeadline));
      else if (between.trim().length > 0) throw xlsxFailure("parse");
    }
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open + 4);
      if (close < 0 || text.slice(open + 4, close).includes("--")) throw xlsxFailure("parse");
      offset = close + 3;
      continue;
    }
    if (text.startsWith("<?", open)) {
      const close = text.indexOf("?>", open + 2);
      if (close < 0) throw xlsxFailure("parse");
      offset = close + 2;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      const close = text.indexOf("]]>", open + 9);
      if (close < 0 || stack.length === 0) throw xlsxFailure("parse");
      handlers.text?.(text.slice(open + 9, close));
      offset = close + 3;
      continue;
    }
    if (text.startsWith("<!", open)) throw xlsxFailure("parse");
    if (text.startsWith("</", open)) {
      let cursor = open + 2;
      while (/\s/.test(text[cursor] ?? "")) cursor++;
      const parsed = xmlNameAt(text, cursor);
      cursor = parsed.end;
      while (/\s/.test(text[cursor] ?? "")) cursor++;
      const element = stack.pop();
      if (text[cursor] !== ">" || !element || element.qualifiedName !== parsed.name)
        throw xlsxFailure("parse");
      handlers.end?.(localName(parsed.name), element.namespace);
      offset = cursor + 1;
      continue;
    }

    let cursor = open + 1;
    const parsedName = xmlNameAt(text, cursor);
    cursor = parsedName.end;
    const attributes = new Map<string, string>();
    let selfClosing = false;
    let terminated = false;
    while (cursor < text.length) {
      while (/\s/.test(text[cursor] ?? "")) cursor++;
      if (text[cursor] === ">") { cursor++; terminated = true; break; }
      if (text[cursor] === "/" && text[cursor + 1] === ">") {
        selfClosing = true;
        terminated = true;
        cursor += 2;
        break;
      }
      const attributeName = xmlNameAt(text, cursor);
      cursor = attributeName.end;
      while (/\s/.test(text[cursor] ?? "")) cursor++;
      if (text[cursor] !== "=") throw xlsxFailure("parse");
      cursor++;
      while (/\s/.test(text[cursor] ?? "")) cursor++;
      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") throw xlsxFailure("parse");
      const close = text.indexOf(quote, cursor + 1);
      if (close < 0 || attributes.has(attributeName.name)
          || attributes.size >= MAX_XML_ATTRIBUTES
          || close - cursor - 1 > MAX_XML_ATTRIBUTE_VALUE_LENGTH
          || text.slice(cursor + 1, close).includes("<")) throw xlsxFailure("parse");
      attributes.set(attributeName.name,
        decodeXmlEntities(text.slice(cursor + 1, close), assertWithinDeadline));
      cursor = close + 1;
    }
    if (!terminated) throw xlsxFailure("parse");
    const namespaces = new Map(stack.at(-1)?.namespaces ?? [["xml", XML_NAMESPACE]]);
    for (const [name, value] of attributes) {
      if (name === "xmlns") {
        if (value === XML_NAMESPACE || value === XMLNS_NAMESPACE) throw xlsxFailure("parse");
        if (value === "") namespaces.delete("");
        else namespaces.set("", value);
      } else if (name.startsWith("xmlns:")) {
        const prefix = name.slice(6);
        if (!prefix || prefix === "xmlns" || value === "" || value === XMLNS_NAMESPACE
            || (prefix === "xml") !== (value === XML_NAMESPACE)) throw xlsxFailure("parse");
        namespaces.set(prefix, value);
      } else {
        const prefix = qualifiedPrefix(name);
        if (prefix && !namespaces.has(prefix)) throw xlsxFailure("parse");
      }
    }
    const expandedAttributes = new Set<string>();
    for (const name of attributes.keys()) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const attributePrefix = qualifiedPrefix(name);
      const expandedName = `${attributePrefix ? namespaces.get(attributePrefix) : ""}\u0000${localName(name)}`;
      if (expandedAttributes.has(expandedName)) throw xlsxFailure("parse");
      expandedAttributes.add(expandedName);
    }
    const prefix = qualifiedPrefix(parsedName.name);
    if (prefix === "xmlns" || (prefix && !namespaces.has(prefix))) throw xlsxFailure("parse");
    const namespace = namespaces.get(prefix) ?? null;
    const local = localName(parsedName.name);
    if (stack.length === 0 && ++rootElements > 1) throw xlsxFailure("parse");
    handlers.start?.(local, attributes, namespace, namespaces);
    if (selfClosing) handlers.end?.(local, namespace);
    else {
      stack.push({ qualifiedName: parsedName.name, namespace, namespaces });
      if (stack.length > MAX_XML_DEPTH) throw xlsxFailure("parse");
    }
    offset = cursor;
  }
  if (stack.length !== 0 || rootElements !== 1) throw xlsxFailure("parse");
}

function resolveRelationshipTarget(sourcePart: string, target: string): string {
  if (target.length < 1 || target.includes("\\") || target.includes("\u0000")
      || target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target))
    throw xlsxFailure("parse");
  const cleanTarget = target.split(/[?#]/, 1)[0]!;
  let segments = sourcePart.includes("/") ? sourcePart.split("/").slice(0, -1) : [];
  if (cleanTarget.startsWith("/")) segments = [];
  for (const segment of cleanTarget.replace(/^\//, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw xlsxFailure("parse");
      segments.pop();
    } else segments.push(segment);
  }
  return normalizedPartName(segments.join("/"));
}

function sourceForRelationshipsPart(part: string): string {
  if (part === "_rels/.rels") return "";
  const marker = "/_rels/";
  const markerAt = part.lastIndexOf(marker);
  if (markerAt < 0 || !part.endsWith(".rels")) throw xlsxFailure("parse");
  return `${part.slice(0, markerAt)}/${part.slice(markerAt + marker.length, -5)}`;
}

function parseRelationships(
  text: string,
  relationshipsPart: string,
  assertWithinDeadline: () => void,
): Relationship[] {
  const sourcePart = sourceForRelationshipsPart(relationshipsPart);
  const relationships: Relationship[] = [];
  const relationshipIds = new Set<string>();
  let depth = 0;
  let sawRoot = false;
  parseXml(text, {
    start(name, attributes, namespace) {
      const acceptedNamespace = PACKAGE_RELATIONSHIP_NAMESPACES.has(namespace ?? "");
      if ((name === "Relationships" || name === "Relationship") && !acceptedNamespace)
        throw xlsxFailure("parse");
      if (name === "Relationships") {
        if (depth !== 0 || sawRoot) throw xlsxFailure("parse");
        sawRoot = true;
      } else if (name === "Relationship") {
        if (depth !== 1 || !sawRoot) throw xlsxFailure("parse");
        const id = attributes.get("Id");
        const type = attributes.get("Type");
        const target = attributes.get("Target");
        const targetMode = attributes.get("TargetMode");
        if (!id || id.length > 255 || !type || !target || relationshipIds.has(id))
          throw xlsxFailure("parse");
        if (targetMode !== undefined && targetMode.toLowerCase() === "external")
          throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "parse");
        if (targetMode !== undefined && targetMode !== "Internal") throw xlsxFailure("parse");
        const foldedType = type.toLowerCase();
        if (/vbaproject|oleobject|activex|externallink|attachedtemplate|package|control/.test(foldedType))
          throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "parse");
        if (relationships.length >= IMPORT_ACQUISITION_LIMITS.maxXlsxEntries)
          throw limitFailure("E_IMPORT_SOURCE_LIMIT", "parse", {
            limit: IMPORT_ACQUISITION_LIMITS.maxXlsxEntries,
            actual: relationships.length + 1,
          });
        relationshipIds.add(id);
        relationships.push({ id, type, target: resolveRelationshipTarget(sourcePart, target) });
      } else if (acceptedNamespace) throw xlsxFailure("parse");
      depth++;
    },
    end() {
      depth--;
      if (depth < 0) throw xlsxFailure("parse");
    },
  }, assertWithinDeadline);
  if (!sawRoot || depth !== 0) throw xlsxFailure("parse");
  return relationships;
}

function assertSafePartNames(entries: ReadonlyMap<string, ZipEntry>): void {
  const forbidden = /(?:^|\/)(?:vbaproject\.bin|vbadata\.xml|activex|embeddings|externallinks|macrosheets|dialogsheets|customui|connections\.xml|encryptioninfo|encryptedpackage)(?:\/|$)/i;
  for (const name of entries.keys()) {
    if (forbidden.test(name) || /\.(?:bin|exe|dll|com|msi)$/i.test(name))
      throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "acquire");
  }
}

function parseContentTypes(text: string, assertWithinDeadline: () => void): void {
  let workbookType: string | null = null;
  let depth = 0;
  let sawRoot = false;
  let declarations = 0;
  const declaredParts = new Set<string>();
  const declaredExtensions = new Set<string>();
  parseXml(text, {
    start(name, attributes, namespace) {
      const acceptedNamespace = CONTENT_TYPES_NAMESPACES.has(namespace ?? "");
      if (["Types", "Default", "Override"].includes(name) && !acceptedNamespace)
        throw xlsxFailure("parse");
      if (name === "Types") {
        if (depth !== 0 || sawRoot) throw xlsxFailure("parse");
        sawRoot = true;
      } else if (name === "Default" || name === "Override") {
        if (depth !== 1 || !sawRoot || declarations >= IMPORT_ACQUISITION_LIMITS.maxXlsxEntries)
          throw xlsxFailure("parse");
        declarations++;
        const contentType = attributes.get("ContentType");
        if (!contentType) throw xlsxFailure("parse");
        const folded = contentType.toLowerCase();
        if (/macroenabled|vba|activex|oleobject|encrypted/.test(folded))
          throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "parse");
        if (name === "Default") {
          const extension = attributes.get("Extension")?.toLowerCase();
          if (!extension || declaredExtensions.has(extension)) throw xlsxFailure("parse");
          declaredExtensions.add(extension);
        } else {
          const partName = attributes.get("PartName");
          if (!partName || !partName.startsWith("/") || declaredParts.has(partName))
            throw xlsxFailure("parse");
          declaredParts.add(partName);
          if (partName === "/xl/workbook.xml") workbookType = contentType;
        }
      } else if (acceptedNamespace) throw xlsxFailure("parse");
      depth++;
    },
    end() {
      depth--;
      if (depth < 0) throw xlsxFailure("parse");
    },
  }, assertWithinDeadline);
  if (!sawRoot || depth !== 0
      || workbookType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
    throw xlsxFailure("parse");
}

function columnOrdinal(letters: string): number {
  let result = 0;
  for (const character of letters.toUpperCase())
    result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function coordinates(reference: string): { row: number; column: number } {
  const matched = CELL_REFERENCE.exec(reference);
  if (!matched) throw xlsxFailure("parse");
  const row = Number(matched[2]);
  const column = columnOrdinal(matched[1]!);
  if (!Number.isSafeInteger(row) || row < 1 || row > MAX_SOURCE_ROWS)
    throw limitFailure("E_IMPORT_ROW_LIMIT", "parse", {
      limit: MAX_SOURCE_ROWS, actual: row,
    });
  if (column < 1 || column > IMPORT_ACQUISITION_LIMITS.maxMappedColumns)
    throw limitFailure("E_IMPORT_COLUMN_LIMIT", "parse", {
      limit: IMPORT_ACQUISITION_LIMITS.maxMappedColumns, actual: column,
    });
  return { row, column };
}

function rangeBounds(reference: string): Bounds {
  const matched = RANGE_REFERENCE.exec(reference);
  if (!matched) throw xlsxFailure("parse");
  const start = coordinates(`${matched[1]}${matched[2]}`);
  const end = coordinates(`${matched[3] ?? matched[1]}${matched[4] ?? matched[2]}`);
  if (end.row < start.row || end.column < start.column) throw xlsxFailure("parse");
  return {
    minRow: start.row,
    maxRow: end.row,
    minColumn: start.column,
    maxColumn: end.column,
  };
}

function unionBounds(left: Bounds | null, right: Bounds): Bounds {
  if (!left) return right;
  return {
    minRow: Math.min(left.minRow, right.minRow),
    maxRow: Math.max(left.maxRow, right.maxRow),
    minColumn: Math.min(left.minColumn, right.minColumn),
    maxColumn: Math.max(left.maxColumn, right.maxColumn),
  };
}

function scanWorksheetBounds(text: string, assertWithinDeadline: () => void): Bounds | null {
  let bounds: Bounds | null = null;
  let sawCell = false;
  let depth = 0;
  let sawWorksheet = false;
  let sawDimension = false;
  let sawSheetData = false;
  let inSheetData = false;
  let inRow = false;
  let currentRow = 0;
  let priorRow = 0;
  let implicitColumn = 0;
  parseXml(text, {
    start(name, attributes, namespace) {
      if ((name === "worksheet" || name === "dimension" || name === "sheetData"
          || name === "row" || name === "c")
          && !SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) throw xlsxFailure("parse");
      if (name === "worksheet") {
        if (depth !== 0 || sawWorksheet) throw xlsxFailure("parse");
        sawWorksheet = true;
      } else if (name === "dimension") {
        if (depth !== 1 || !sawWorksheet || sawDimension) throw xlsxFailure("parse");
        sawDimension = true;
        const reference = attributes.get("ref");
        if (!reference) throw xlsxFailure("parse");
        bounds = unionBounds(bounds, rangeBounds(reference));
      } else if (name === "sheetData") {
        if (depth !== 1 || !sawWorksheet || sawSheetData || inSheetData || inRow)
          throw xlsxFailure("parse");
        sawSheetData = true;
        inSheetData = true;
      } else if (name === "row") {
        if (depth !== 2 || !inSheetData || inRow) throw xlsxFailure("parse");
        const raw = attributes.get("r");
        currentRow = raw === undefined ? priorRow + 1 : Number(raw);
        if (!Number.isSafeInteger(currentRow) || currentRow < 1 || currentRow > MAX_SOURCE_ROWS)
          throw limitFailure("E_IMPORT_ROW_LIMIT", "parse", {
            limit: MAX_SOURCE_ROWS, actual: Number.isFinite(currentRow) ? currentRow : 0,
          });
        if (currentRow <= priorRow) throw xlsxFailure("parse");
        priorRow = currentRow;
        implicitColumn = 0;
        inRow = true;
      } else if (name === "c") {
        if (depth !== 3 || !inRow) throw xlsxFailure("parse");
        sawCell = true;
        const reference = attributes.get("r");
        const cell = reference ? coordinates(reference) : { row: currentRow, column: implicitColumn + 1 };
        if (cell.row !== currentRow || cell.column <= implicitColumn) throw xlsxFailure("parse");
        implicitColumn = cell.column;
        bounds = unionBounds(bounds, {
          minRow: cell.row, maxRow: cell.row,
          minColumn: cell.column, maxColumn: cell.column,
        });
      }
      depth++;
    },
    end(name, namespace) {
      depth--;
      if (depth < 0) throw xlsxFailure("parse");
      if (name === "row" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inRow || depth !== 2) throw xlsxFailure("parse");
        inRow = false;
      } else if (name === "sheetData" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inSheetData || inRow || depth !== 1) throw xlsxFailure("parse");
        inSheetData = false;
      }
    },
  }, assertWithinDeadline);
  if (!sawWorksheet || !sawSheetData || inSheetData || inRow || depth !== 0)
    throw xlsxFailure("parse");
  return sawCell ? bounds : null;
}

function workbookMetadata(
  text: string,
  relationships: ReadonlyMap<string, Relationship>,
  entries: ReadonlyMap<string, ZipEntry>,
  assertWithinDeadline: () => void,
): { date1904: boolean; sheets: Array<{ label: string; visibility: SheetDescriptor["visibility"];
  part: string }> } {
  let date1904 = false;
  let depth = 0;
  let sawRoot = false;
  let sawWorkbookProperties = false;
  let sawSheets = false;
  let inSheets = false;
  const sheetIds = new Set<number>();
  const sheetLabels = new Set<string>();
  const sheetParts = new Set<string>();
  const sheets: Array<{ label: string; visibility: SheetDescriptor["visibility"]; part: string }> = [];
  parseXml(text, {
    start(name, attributes, namespace, namespaces) {
      const acceptedNamespace = SPREADSHEET_XML_NAMESPACES.has(namespace ?? "");
      if (["workbook", "workbookPr", "sheets", "sheet"].includes(name) && !acceptedNamespace)
        throw xlsxFailure("parse");
      if (name === "workbook") {
        if (depth !== 0 || sawRoot) throw xlsxFailure("parse");
        sawRoot = true;
      } else if (name === "workbookPr") {
        if (depth !== 1 || !sawRoot || sawWorkbookProperties) throw xlsxFailure("parse");
        sawWorkbookProperties = true;
        const raw = attributes.get("date1904");
        if (raw !== undefined && raw !== "0" && raw !== "1"
            && raw !== "false" && raw !== "true") throw xlsxFailure("parse");
        date1904 = raw === "1" || raw === "true";
      } else if (name === "sheets") {
        if (depth !== 1 || !sawRoot || sawSheets) throw xlsxFailure("parse");
        sawSheets = true;
        inSheets = true;
      } else if (name === "sheet") {
        if (depth !== 2 || !inSheets || sheets.length >= IMPORT_ACQUISITION_LIMITS.maxXlsxEntries)
          throw xlsxFailure("parse");
        const label = attributes.get("name");
        const relationId = namespacedAttribute(
          attributes, namespaces, "id", OFFICE_RELATIONSHIP_NAMESPACES,
        );
        const rawSheetId = attributes.get("sheetId");
        const sheetId = Number(rawSheetId);
        const state = attributes.get("state") ?? "visible";
        if (!label || label.length > 120 || !relationId
            || !/^[1-9][0-9]*$/.test(rawSheetId ?? "") || !Number.isSafeInteger(sheetId)
            || sheetId > 0xffffffff || sheetIds.has(sheetId)
            || sheetLabels.has(label.toLowerCase())
            || (state !== "visible" && state !== "hidden" && state !== "veryHidden"))
          throw xlsxFailure("parse");
        sheetIds.add(sheetId);
        sheetLabels.add(label.toLowerCase());
        const relationship = relationships.get(relationId);
        if (!relationship) throw xlsxFailure("parse");
        if (hasOfficeRelationshipType(relationship.type, "/worksheet")) {
          if (!entries.has(relationship.target) || sheetParts.has(relationship.target))
            throw xlsxFailure("parse");
          sheetParts.add(relationship.target);
          sheets.push({
            label,
            visibility: state === "veryHidden" ? "very_hidden" : state,
            part: relationship.target,
          });
        }
      }
      depth++;
    },
    end(name, namespace) {
      depth--;
      if (depth < 0) throw xlsxFailure("parse");
      if (name === "sheets" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inSheets || depth !== 1) throw xlsxFailure("parse");
        inSheets = false;
      }
    },
  }, assertWithinDeadline);
  if (!sawRoot || !sawSheets || inSheets || depth !== 0 || sheets.length < 1)
    throw xlsxFailure("parse");
  return { date1904, sheets };
}

function parseSharedStrings(
  text: string,
  assertWithinDeadline: () => void,
): { values: string[]; decodedBytes: number } {
  const values: string[] = [];
  let depth = 0;
  let sawRoot = false;
  let inItem = false;
  let inRun = false;
  let inPhonetic = false;
  let inTextElement = false;
  let captureText = false;
  let item = "";
  let decodedBytes = 0;
  parseXml(text, {
    start(name, _attributes, namespace) {
      if (["sst", "si", "t", "r", "rPh"].includes(name)
          && !SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) throw xlsxFailure("parse");
      if (name === "sst") {
        if (depth !== 0 || sawRoot) throw xlsxFailure("parse");
        sawRoot = true;
      } else if (name === "si") {
        if (depth !== 1 || !sawRoot || inItem || values.length >= MAX_WORKSHEET_CELLS)
          throw xlsxFailure("parse");
        inItem = true;
        item = "";
      } else if (name === "r") {
        if (depth !== 2 || !inItem || inRun || inPhonetic) throw xlsxFailure("parse");
        inRun = true;
      } else if (name === "rPh") {
        if (depth !== 2 || !inItem || inRun || inPhonetic) throw xlsxFailure("parse");
        inPhonetic = true;
      } else if (name === "t") {
        const validText = inItem && !inTextElement
          && ((depth === 2 && !inRun && !inPhonetic)
            || (depth === 3 && (inRun || inPhonetic)));
        if (!validText) throw xlsxFailure("parse");
        inTextElement = true;
        captureText = !inPhonetic;
      }
      depth++;
    },
    text(value) {
      if (inItem && inTextElement && captureText) item += value;
    },
    end(name, namespace) {
      depth--;
      if (depth < 0) throw xlsxFailure("parse");
      if (name === "t" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inTextElement) throw xlsxFailure("parse");
        inTextElement = false;
        captureText = false;
      } else if (name === "r" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inRun || depth !== 2) throw xlsxFailure("parse");
        inRun = false;
      } else if (name === "rPh" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inPhonetic || depth !== 2) throw xlsxFailure("parse");
        inPhonetic = false;
      }
      else if (name === "si") {
        if (!inItem || inRun || inPhonetic || inTextElement || depth !== 1)
          throw xlsxFailure("parse");
        const size = encoder.encode(item).byteLength;
        if (size > IMPORT_ACQUISITION_LIMITS.maxDecodedCellBytes)
          throw limitFailure("E_IMPORT_CELL_LIMIT", "parse", {
            row: values.length + 1, column: 1,
            limit: IMPORT_ACQUISITION_LIMITS.maxDecodedCellBytes, actual: size,
          });
        decodedBytes += size;
        if (decodedBytes > IMPORT_ACQUISITION_LIMITS.maxDecodedCellsBytes)
          throw limitFailure("E_IMPORT_DECODED_LIMIT", "parse", {
            limit: IMPORT_ACQUISITION_LIMITS.maxDecodedCellsBytes,
            actual: decodedBytes,
          });
        values.push(item);
        inItem = false;
      }
    },
  }, assertWithinDeadline);
  if (!sawRoot || depth !== 0 || inItem || inRun || inPhonetic || inTextElement)
    throw xlsxFailure("parse");
  return { values, decodedBytes };
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function customFormatIsDate(format: string): boolean {
  let visible = "";
  for (let index = 0; index < format.length; index++) {
    const character = format[index]!;
    if (character === '"') {
      const end = format.indexOf('"', index + 1);
      if (end < 0) return false;
      index = end;
    } else if (character === "\\" || character === "_" || character === "*") index++;
    else if (character === "[") {
      const end = format.indexOf("]", index + 1);
      if (end < 0) return false;
      const bracket = format.slice(index + 1, end).toLowerCase();
      if (/^[hms]+$/.test(bracket)) visible += bracket;
      index = end;
    } else visible += character.toLowerCase();
  }
  return /(?:^|[^a-z])(?:y+|d+|h+|s+|m+)(?:[^a-z]|$)|am\/pm/.test(visible);
}

function parseDateStyles(
  text: string,
  assertWithinDeadline: () => void,
): { dateStyles: Set<number>; styleCount: number } {
  const custom = new Map<number, string>();
  const xfs: number[] = [];
  let depth = 0;
  let sawRoot = false;
  let sawNumFmts = false;
  let inNumFmts = false;
  let sawCellXfs = false;
  let inCellXfs = false;
  let declaredCellXfs: number | null = null;
  parseXml(text, {
    start(name, attributes, namespace) {
      if (["styleSheet", "numFmts", "numFmt", "cellXfs", "xf"].includes(name)
          && !SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) throw xlsxFailure("parse");
      if (name === "styleSheet") {
        if (depth !== 0 || sawRoot) throw xlsxFailure("parse");
        sawRoot = true;
      } else if (name === "numFmts") {
        if (depth !== 1 || !sawRoot || sawNumFmts) throw xlsxFailure("parse");
        sawNumFmts = true;
        inNumFmts = true;
      } else if (name === "numFmt") {
        if (depth !== 2 || !inNumFmts || custom.size >= MAX_CELL_STYLES)
          throw xlsxFailure("parse");
        const id = Number(attributes.get("numFmtId"));
        const format = attributes.get("formatCode");
        if (!Number.isSafeInteger(id) || id < 0 || id > 0xffff || !format || custom.has(id))
          throw xlsxFailure("parse");
        custom.set(id, format);
      } else if (name === "cellXfs") {
        if (depth !== 1 || !sawRoot || sawCellXfs) throw xlsxFailure("parse");
        const rawCount = attributes.get("count");
        if (rawCount !== undefined) {
          const count = Number(rawCount);
          if (!/^(?:0|[1-9][0-9]*)$/.test(rawCount) || !Number.isSafeInteger(count)
              || count > MAX_CELL_STYLES) throw xlsxFailure("parse");
          declaredCellXfs = count;
        }
        sawCellXfs = true;
        inCellXfs = true;
      }
      else if (name === "xf" && inCellXfs) {
        if (depth !== 2 || xfs.length >= MAX_CELL_STYLES) throw xlsxFailure("parse");
        const id = Number(attributes.get("numFmtId") ?? "0");
        if (!Number.isSafeInteger(id) || id < 0 || id > 0xffff) throw xlsxFailure("parse");
        xfs.push(id);
      }
      depth++;
    },
    end(name, namespace) {
      depth--;
      if (depth < 0) throw xlsxFailure("parse");
      if (name === "numFmts" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inNumFmts || depth !== 1) throw xlsxFailure("parse");
        inNumFmts = false;
      } else if (name === "cellXfs" && SPREADSHEET_XML_NAMESPACES.has(namespace ?? "")) {
        if (!inCellXfs || depth !== 1) throw xlsxFailure("parse");
        inCellXfs = false;
      }
    },
  }, assertWithinDeadline);
  if (!sawRoot || !sawCellXfs || inNumFmts || inCellXfs || depth !== 0 || xfs.length === 0
      || (declaredCellXfs !== null && declaredCellXfs !== xfs.length)) throw xlsxFailure("parse");
  const dateStyles = new Set(xfs.map((formatId, styleIndex) =>
    BUILTIN_DATE_FORMATS.has(formatId) || customFormatIsDate(custom.get(formatId) ?? "")
      ? styleIndex : -1).filter(index => index >= 0));
  return { dateStyles, styleCount: xfs.length };
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function civilFromDays(daysSinceUnixEpoch: number): { year: number; month: number; day: number } {
  let z = daysSinceUnixEpoch + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460)
    + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

function excelDate(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial) || serial < 0) throw xlsxFailure("parse");
  let wholeDays = Math.floor(serial);
  if (!date1904 && wholeDays === 60) throw xlsxFailure("parse");
  let milliseconds = Math.round((serial - wholeDays) * 86_400_000);
  if (milliseconds === 86_400_000) {
    wholeDays++;
    milliseconds = 0;
  }
  const unixDays = date1904 ? wholeDays - 24_107
    : wholeDays - 25_568 - (wholeDays > 60 ? 1 : 0);
  const date = civilFromDays(unixDays);
  if (date.year < 1 || date.year > 9999) throw xlsxFailure("parse");
  const calendar = `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
  if (milliseconds === 0) return calendar;
  const hours = Math.floor(milliseconds / 3_600_000);
  milliseconds -= hours * 3_600_000;
  const minutes = Math.floor(milliseconds / 60_000);
  milliseconds -= minutes * 60_000;
  const seconds = Math.floor(milliseconds / 1_000);
  milliseconds -= seconds * 1_000;
  return `${calendar}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    + `${milliseconds === 0 ? "" : `.${pad(milliseconds, 3)}`}Z`;
}

function worksheetRows(
  text: string,
  bounds: Bounds,
  sharedStrings: readonly string[],
  dateStyles: ReadonlySet<number>,
  styleCount: number,
  date1904: boolean,
  assertWithinDeadline: () => void,
): string[][] {
  const rows = Array.from({ length: bounds.maxRow }, () =>
    Array.from({ length: bounds.maxColumn }, () => ""));
  let depth = 0;
  let currentRow = 0;
  let implicitColumn = 0;
  let cell: {
    row: number;
    column: number;
    type: string;
    style: number;
    value: string;
    inline: string;
    formula: string;
    inValue: boolean;
    inInlineString: boolean;
    inInlineRun: boolean;
    inInlineText: boolean;
    inPhonetic: boolean;
    inFormula: boolean;
    hasValue: boolean;
    hasInlineString: boolean;
    hasFormula: boolean;
  } | null = null;
  let decodedTotal = 0;

  const finishCell = (): void => {
    if (!cell) throw xlsxFailure("parse");
    if (cell.inValue || cell.inInlineString || cell.inInlineRun || cell.inInlineText
        || cell.inPhonetic || cell.inFormula) throw xlsxFailure("parse");
    if (cell.hasFormula && !cell.hasValue)
      throw new ImportParserError("E_IMPORT_XLSX_FORMULA", "parse");
    if (cell.hasFormula && /[\[\]|]/.test(cell.formula))
      throw new ImportParserError("E_IMPORT_XLSX_UNSAFE", "parse");
    if (cell.style >= styleCount) throw xlsxFailure("parse");
    if ((cell.type === "inlineStr") !== cell.hasInlineString || cell.hasValue && cell.hasInlineString)
      throw xlsxFailure("parse");
    let value = "";
    if (cell.type === "inlineStr") value = cell.inline;
    else if (!cell.hasValue) value = "";
    else if (cell.type === "s") {
      if (!/^(?:0|[1-9][0-9]*)$/.test(cell.value)) throw xlsxFailure("parse");
      const shared = sharedStrings[Number(cell.value)];
      if (shared === undefined) throw xlsxFailure("parse");
      value = shared;
    } else if (cell.type === "b") {
      if (cell.value !== "0" && cell.value !== "1") throw xlsxFailure("parse");
      value = cell.value === "1" ? "true" : "false";
    } else if (cell.type === "e" || cell.type === "str") value = cell.value;
    else if (cell.type === "d") {
      if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?)?$/.test(cell.value))
        throw xlsxFailure("parse");
      value = cell.value;
    } else {
      if (cell.type !== "" && cell.type !== "n") throw xlsxFailure("parse");
      if (!NUMBER_TEXT.test(cell.value) || !Number.isFinite(Number(cell.value)))
        throw xlsxFailure("parse");
      value = dateStyles.has(cell.style) ? excelDate(Number(cell.value), date1904) : cell.value;
    }
    const size = encoder.encode(value).byteLength;
    if (size > IMPORT_ACQUISITION_LIMITS.maxDecodedCellBytes)
      throw limitFailure("E_IMPORT_CELL_LIMIT", "parse", {
        row: cell.row, column: cell.column,
        limit: IMPORT_ACQUISITION_LIMITS.maxDecodedCellBytes, actual: size,
      });
    decodedTotal += size;
    if (decodedTotal > IMPORT_ACQUISITION_LIMITS.maxDecodedCellsBytes)
      throw limitFailure("E_IMPORT_DECODED_LIMIT", "parse", {
        row: cell.row, column: cell.column,
        limit: IMPORT_ACQUISITION_LIMITS.maxDecodedCellsBytes, actual: decodedTotal,
      });
    rows[cell.row - 1]![cell.column - 1] = value;
    cell = null;
  };

  parseXml(text, {
    start(name, attributes, namespace) {
      if (["worksheet", "sheetData", "row", "c", "v", "t", "f", "is", "r", "rPh"]
        .includes(name) && !SPREADSHEET_XML_NAMESPACES.has(namespace ?? ""))
        throw xlsxFailure("parse");
      if (cell && (cell.inValue || cell.inInlineText || cell.inFormula))
        throw xlsxFailure("parse");
      if (name === "worksheet") {
        if (depth !== 0) throw xlsxFailure("parse");
      } else if (name === "sheetData") {
        if (depth !== 1) throw xlsxFailure("parse");
      } else if (name === "row") {
        if (depth !== 2 || cell) throw xlsxFailure("parse");
        const raw = attributes.get("r");
        const nextRow = raw === undefined ? currentRow + 1 : Number(raw);
        if (!Number.isSafeInteger(nextRow) || nextRow <= currentRow || nextRow > bounds.maxRow)
          throw xlsxFailure("parse");
        currentRow = nextRow;
        implicitColumn = 0;
      } else if (name === "c") {
        if (depth !== 3 || cell) throw xlsxFailure("parse");
        const reference = attributes.get("r");
        const coordinate = reference ? coordinates(reference)
          : { row: currentRow, column: implicitColumn + 1 };
        if (coordinate.row !== currentRow || coordinate.column <= implicitColumn
            || coordinate.column > bounds.maxColumn) throw xlsxFailure("parse");
        implicitColumn = coordinate.column;
        const style = Number(attributes.get("s") ?? "0");
        if (!Number.isSafeInteger(style) || style < 0) throw xlsxFailure("parse");
        cell = {
          ...coordinate,
          type: attributes.get("t") ?? "",
          style,
          value: "",
          inline: "",
          formula: "",
          inValue: false,
          inInlineString: false,
          inInlineRun: false,
          inInlineText: false,
          inPhonetic: false,
          inFormula: false,
          hasValue: false,
          hasInlineString: false,
          hasFormula: false,
        };
      } else if (name === "v") {
        if (!cell || depth !== 4 || cell.hasValue) throw xlsxFailure("parse");
        cell.inValue = true;
        cell.hasValue = true;
      } else if (name === "is") {
        if (!cell || depth !== 4 || cell.type !== "inlineStr" || cell.hasInlineString)
          throw xlsxFailure("parse");
        cell.inInlineString = true;
        cell.hasInlineString = true;
      } else if (name === "r") {
        if (!cell || depth !== 5 || !cell.inInlineString || cell.inInlineRun
            || cell.inPhonetic) throw xlsxFailure("parse");
        cell.inInlineRun = true;
      } else if (name === "rPh") {
        if (!cell || depth !== 5 || !cell.inInlineString || cell.inInlineRun
            || cell.inPhonetic) throw xlsxFailure("parse");
        cell.inPhonetic = true;
      } else if (name === "t") {
        const validText = cell?.type === "inlineStr" && cell.inInlineString
          && !cell.inInlineText && ((depth === 5 && !cell.inInlineRun && !cell.inPhonetic)
            || (depth === 6 && (cell.inInlineRun || cell.inPhonetic)));
        if (!cell || !validText) throw xlsxFailure("parse");
        cell.inInlineText = true;
      } else if (name === "f") {
        if (!cell || depth !== 4 || cell.hasFormula) throw xlsxFailure("parse");
        const formulaType = attributes.get("t");
        if (formulaType === "array" || formulaType === "dataTable") throw xlsxFailure("parse");
        cell.inFormula = true;
        cell.hasFormula = true;
      }
      depth++;
    },
    text(value) {
      if (!cell) return;
      if (cell.inValue) {
        if (depth !== 5) throw xlsxFailure("parse");
        cell.value += value;
      } else if (cell.inInlineText) {
        if (depth !== (cell.inInlineRun || cell.inPhonetic ? 7 : 6)) throw xlsxFailure("parse");
        if (!cell.inPhonetic) cell.inline += value;
      } else if (cell.inFormula) {
        if (depth !== 5) throw xlsxFailure("parse");
        cell.formula += value;
      }
    },
    end(name, namespace) {
      depth--;
      if (depth < 0) throw xlsxFailure("parse");
      const spreadsheet = SPREADSHEET_XML_NAMESPACES.has(namespace ?? "");
      if (name === "v" && spreadsheet) {
        if (!cell?.inValue || depth !== 4) throw xlsxFailure("parse");
        cell.inValue = false;
      } else if (name === "t" && spreadsheet) {
        if (!cell?.inInlineText) throw xlsxFailure("parse");
        cell.inInlineText = false;
      } else if (name === "r" && spreadsheet) {
        if (!cell?.inInlineRun || depth !== 5) throw xlsxFailure("parse");
        cell.inInlineRun = false;
      } else if (name === "rPh" && spreadsheet) {
        if (!cell?.inPhonetic || depth !== 5) throw xlsxFailure("parse");
        cell.inPhonetic = false;
      } else if (name === "is" && spreadsheet) {
        if (!cell?.inInlineString || cell.inInlineRun || cell.inPhonetic
            || cell.inInlineText || depth !== 4) throw xlsxFailure("parse");
        cell.inInlineString = false;
      } else if (name === "f" && spreadsheet) {
        if (!cell?.inFormula || depth !== 4) throw xlsxFailure("parse");
        cell.inFormula = false;
      } else if (name === "c" && spreadsheet) {
        if (depth !== 3) throw xlsxFailure("parse");
        finishCell();
      }
    },
  }, assertWithinDeadline);
  if (depth !== 0 || cell) throw xlsxFailure("parse");
  return rows;
}

async function digestSource(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function relationshipBySuffix(
  relationships: readonly Relationship[],
  suffix: string,
): Relationship | null {
  return relationships.find(relationship =>
    hasOfficeRelationshipType(relationship.type, suffix)) ?? null;
}

export async function openXlsxWorkbook(
  source: Uint8Array,
  environment: XlsxAdapterEnvironment = {},
): Promise<OpenedXlsxWorkbook> {
  const assertWithinDeadline = deadline(environment);
  const entries = parseZipDirectory(source, assertWithinDeadline);
  assertSafePartNames(entries);

  const xmlByRequiredPart = new Map<string, string>();
  const relationshipsByPart = new Map<string, Relationship[]>();
  for (const entry of entries.values()) {
    assertWithinDeadline();
    const foldedName = entry.name.toLowerCase();
    if (!foldedName.endsWith(".xml") && !foldedName.endsWith(".rels")) continue;
    const text = xmlText(await expandEntry(source, entry, assertWithinDeadline));
    if (foldedName.endsWith(".rels"))
      relationshipsByPart.set(entry.name,
        parseRelationships(text, entry.name, assertWithinDeadline));
    if (entry.name === "[Content_Types].xml" || entry.name === "xl/workbook.xml")
      xmlByRequiredPart.set(entry.name, text);
  }

  const contentTypes = xmlByRequiredPart.get("[Content_Types].xml");
  const rootRelationships = relationshipsByPart.get("_rels/.rels");
  if (!contentTypes || !rootRelationships) throw xlsxFailure("parse");
  parseContentTypes(contentTypes, assertWithinDeadline);
  const officeDocument = relationshipBySuffix(rootRelationships, "/officedocument");
  if (!officeDocument || officeDocument.target !== "xl/workbook.xml") throw xlsxFailure("parse");
  const workbookEntry = entries.get(officeDocument.target);
  if (!workbookEntry) throw xlsxFailure("parse");
  const workbookText = xmlByRequiredPart.get(officeDocument.target)
    ?? xmlText(await expandEntry(source, workbookEntry, assertWithinDeadline));
  const workbookRelationshipsPart = "xl/_rels/workbook.xml.rels";
  const workbookRelationships = relationshipsByPart.get(workbookRelationshipsPart);
  if (!workbookRelationships) throw xlsxFailure("parse");
  const relationshipsById = new Map(workbookRelationships.map(item => [item.id, item]));
  const metadata = workbookMetadata(
    workbookText, relationshipsById, entries, assertWithinDeadline,
  );

  const sheets: SheetInfo[] = [];
  for (let index = 0; index < metadata.sheets.length; index++) {
    assertWithinDeadline();
    const sheet = metadata.sheets[index]!;
    const entry = entries.get(sheet.part)!;
    const text = xmlText(await expandEntry(source, entry, assertWithinDeadline));
    const bounds = scanWorksheetBounds(text, assertWithinDeadline);
    sheets.push({
      part: sheet.part,
      descriptor: {
        sheetId: `sheet_${index + 1}`,
        label: sheet.label,
        visibility: sheet.visibility,
        range: bounds === null ? { rows: 0, columns: 0 } : {
          rows: bounds.maxRow,
          columns: bounds.maxColumn,
        },
      },
    });
  }
  const sourceDigest = await digestSource(source);
  assertWithinDeadline();

  return {
    sourceDigest,
    sheets: sheets.map(sheet => sheet.descriptor),
    async readSheet(sheetId: string): Promise<string[][]> {
      const readDeadline = deadline(environment);
      const sheet = sheets.find(candidate => candidate.descriptor.sheetId === sheetId);
      if (!sheet) throw xlsxFailure("parse");
      if (sheet.descriptor.range.rows === 0 || sheet.descriptor.range.columns === 0)
        throw new ImportParserError("E_IMPORT_EMPTY_SOURCE", "parse");
      const sharedRelationship = relationshipBySuffix(workbookRelationships, "/sharedstrings");
      let sharedStrings: readonly string[] = [];
      if (sharedRelationship) {
        const sharedEntry = entries.get(sharedRelationship.target);
        if (!sharedEntry) throw xlsxFailure("parse");
        sharedStrings = parseSharedStrings(
          xmlText(await expandEntry(source, sharedEntry, readDeadline)), readDeadline,
        ).values;
      }
      const stylesRelationship = relationshipBySuffix(workbookRelationships, "/styles");
      let dateStyles: ReadonlySet<number> = new Set();
      let styleCount = 1;
      if (stylesRelationship) {
        const stylesEntry = entries.get(stylesRelationship.target);
        if (!stylesEntry) throw xlsxFailure("parse");
        const styles = parseDateStyles(
          xmlText(await expandEntry(source, stylesEntry, readDeadline)), readDeadline,
        );
        dateStyles = styles.dateStyles;
        styleCount = styles.styleCount;
      }
      const entry = entries.get(sheet.part)!;
      const text = xmlText(await expandEntry(source, entry, readDeadline));
      const bounds = scanWorksheetBounds(text, readDeadline);
      if (!bounds) throw new ImportParserError("E_IMPORT_EMPTY_SOURCE", "parse");
      return worksheetRows(
        text, bounds, sharedStrings, dateStyles, styleCount, metadata.date1904, readDeadline,
      );
    },
  };
}

/** Backward-compatible fail-closed entry retained for old callers during rollout. */
export function rejectUnavailableXlsx(bytes: ArrayBuffer): never {
  if (bytes.byteLength > IMPORT_ACQUISITION_LIMITS.maxCompressedXlsxBytes)
    throw limitFailure("E_IMPORT_SOURCE_LIMIT", "acquire", {
      limit: IMPORT_ACQUISITION_LIMITS.maxCompressedXlsxBytes,
      actual: bytes.byteLength,
    });
  throw new ImportParserError("E_IMPORT_XLSX_UNAVAILABLE", "acquire");
}
