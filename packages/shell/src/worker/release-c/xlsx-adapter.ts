import { IMPORT_ACQUISITION_LIMITS } from "@clay/kernel/import-contracts";
import { ImportParserError } from "./csv-parser";

/**
 * Release C XLSX boundary (C-FR-002, C-NFR-013).
 *
 * Deliberately fail-closed. No OOXML bytes are opened until a pinned adapter
 * has passed license, supply-chain, ZIP/XML bounds, formula, date-system,
 * browser-worker, and lazy-bundle review. In particular, do not substitute
 * the vulnerable public `xlsx` npm release or an unreviewed fork/CDN asset.
 */
export function rejectUnavailableXlsx(bytes: ArrayBuffer): never {
  if (bytes.byteLength > IMPORT_ACQUISITION_LIMITS.maxCompressedXlsxBytes) {
    throw new ImportParserError("E_IMPORT_SOURCE_LIMIT", "acquire", {
      limit: IMPORT_ACQUISITION_LIMITS.maxCompressedXlsxBytes,
      actual: bytes.byteLength,
    });
  }
  throw new ImportParserError("E_IMPORT_XLSX_UNAVAILABLE", "acquire");
}
