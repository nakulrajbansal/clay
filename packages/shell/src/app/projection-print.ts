import type { ProjectionPlaintextV1 } from "@clay/kernel/projection";

const PRINT_ROWS_PER_SHEET = 150;
const PRINT_FIELDS_PER_SHEET = 4;
export const MAX_PRINT_CELLS_PER_TASK = PRINT_ROWS_PER_SHEET * PRINT_FIELDS_PER_SHEET;

export type ProjectionPrintOptions = Readonly<{
  signal?: AbortSignal;
  yieldToMain?: () => Promise<void>;
}>;

function abortError(): Error {
  const error = new Error("Print preparation was cancelled.");
  error.name = "AbortError";
  return error;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K, text: string, className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function defaultYieldToMain(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

function starts(total: number, size: number): number[] {
  if (total === 0) return [0];
  return Array.from({ length: Math.ceil(total / size) }, (_, index) => index * size);
}

/**
 * Builds the complete print surface outside React. Each task creates at most
 * 600 cells, then yields so the owner UI remains responsive at the supported
 * 5,000-row by 30-field maximum. Field bands make wide output deterministic
 * and readable rather than relying on browser-dependent horizontal clipping.
 */
export async function prepareProjectionPrintDocument(
  plaintext: ProjectionPlaintextV1,
  scope: string,
  options: ProjectionPrintOptions = {},
): Promise<HTMLElement> {
  const { signal, yieldToMain = defaultYieldToMain } = options;
  assertActive(signal);
  const { manifest, rows } = plaintext;
  const root = document.createElement("article");
  root.className = "projection-print-root";
  root.dataset.renderer = `${manifest.renderer.id}@${manifest.renderer.version}`;
  root.dataset.printRows = String(manifest.rowCount);
  root.dataset.printFields = String(manifest.fieldCount);
  root.dataset.printTotalCells = String(manifest.rowCount * manifest.fieldCount);
  root.setAttribute("aria-hidden", "true");

  const header = document.createElement("header");
  header.className = "projection-print-header";
  header.append(
    textElement("h1", manifest.title),
    textElement("p", `${manifest.rowCount} rows × ${manifest.fieldCount} fields · Complete, no truncation`),
  );
  root.append(header);
  document.body.append(root);

  try {
    for (const rowStart of starts(rows.length, PRINT_ROWS_PER_SHEET)) {
      const rowEnd = Math.min(rowStart + PRINT_ROWS_PER_SHEET, rows.length);
      for (const fieldStart of starts(manifest.fields.length, PRINT_FIELDS_PER_SHEET)) {
        assertActive(signal);
        const fieldEnd = Math.min(fieldStart + PRINT_FIELDS_PER_SHEET, manifest.fields.length);
        const sheet = document.createElement("section");
        sheet.className = "projection-print-sheet";
        sheet.dataset.rowStart = String(rowStart);
        sheet.dataset.rowEnd = String(rowEnd);
        sheet.dataset.fieldStart = String(fieldStart);
        sheet.dataset.fieldEnd = String(fieldEnd);

        const segment = `Rows ${rows.length === 0 ? 0 : rowStart + 1}–${rowEnd}`
          + ` · Fields ${fieldStart + 1}–${fieldEnd}`;
        sheet.append(textElement("h2", segment, "projection-print-segment"));
        const table = document.createElement("table");
        table.className = "projection-print-table";
        table.append(textElement("caption", `${scope} · ${segment}`));
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (let fieldIndex = fieldStart; fieldIndex < fieldEnd; fieldIndex++) {
          const cell = textElement("th", manifest.fields[fieldIndex]!.label);
          cell.scope = "col";
          headRow.append(cell);
        }
        head.append(headRow);
        table.append(head);

        const body = document.createElement("tbody");
        for (let rowIndex = rowStart; rowIndex < rowEnd; rowIndex++) {
          const tableRow = document.createElement("tr");
          const row = rows[rowIndex]!;
          for (let fieldIndex = fieldStart; fieldIndex < fieldEnd; fieldIndex++)
            tableRow.append(textElement("td", row[fieldIndex] ?? ""));
          body.append(tableRow);
        }
        table.append(body);
        sheet.append(table);
        root.append(sheet);
        await yieldToMain();
        assertActive(signal);
      }
    }
    root.dataset.printReady = "true";
    return root;
  } catch (error) {
    root.remove();
    throw error;
  }
}
