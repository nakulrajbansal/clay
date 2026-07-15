// Bring-your-own-data: parse an uploaded CSV/TSV/JSON file in the TRUSTED
// shell (never a panel — panels have no file/network access), infer a schema,
// and produce clean typed rows. The worker then creates the table + inserts
// the rows as a normal reversible commit; the model builds the dashboard.

export type ImportColumn = { name: string; type: "text" | "number" | "date" | "enum"; values?: string[] };
export type ParsedFile = { table: string; columns: ImportColumn[]; rows: Record<string, unknown>[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/;
const NUM_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$|^-?\$?\d+(\.\d+)?$/;

/** A safe snake_case identifier from an arbitrary header. */
export function sanitizeIdent(raw: string, fallback: string): string {
  let s = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = fallback;
  if (/^\d/.test(s)) s = "c_" + s;
  return s.slice(0, 40);
}

function tableNameFrom(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return sanitizeIdent(base, "data") || "data";
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = []; let field = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

function parseDelimited(text: string): { headers: string[]; rows: string[][] } {
  // join quoted newlines: walk char-by-char to split into logical rows
  const lines: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    if ((c === "\n") && !q) { lines.push(cur); cur = ""; }
    else if (c !== "\r" || q) cur += c;
  }
  if (cur.trim() !== "") lines.push(cur);
  const nonEmpty = lines.filter(l => l.trim() !== "");
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const first = nonEmpty[0]!;
  const delim = first.split("\t").length > first.split(",").length ? "\t" : ",";
  const headers = splitLine(first, delim);
  const rows = nonEmpty.slice(1).map(l => splitLine(l, delim));
  return { headers, rows };
}

const cleanNum = (v: string): number => Number(v.replace(/[$,]/g, ""));

/** Infer a column type from ALL its values (safe: enum sets are complete). */
function inferType(values: string[]): ImportColumn {
  const nonEmpty = values.map(v => v.trim()).filter(v => v !== "");
  if (nonEmpty.length === 0) return { name: "", type: "text" };
  const allNum = nonEmpty.every(v => NUM_RE.test(v) && !Number.isNaN(cleanNum(v)));
  if (allNum) return { name: "", type: "number" };
  const allDate = nonEmpty.every(v => DATE_RE.test(v) && !Number.isNaN(Date.parse(v)));
  if (allDate) return { name: "", type: "date" };
  // enum only when there's enough evidence: a handful of short values that
  // clearly repeat (so a name/title column with many distinct values stays
  // text). Needs a reasonable sample.
  const distinct = [...new Set(nonEmpty)];
  if (nonEmpty.length >= 6 && distinct.length >= 2 && distinct.length <= 8
      && distinct.length <= nonEmpty.length * 0.5 && distinct.every(v => v.length <= 24))
    return { name: "", type: "enum", values: distinct };
  return { name: "", type: "text" };
}

function isoDate(v: string): string {
  // normalise to YYYY-MM-DD for the kernel's date coercion
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
}

/** Parse a file's text into a ready-to-import table (schema + typed rows). */
export function parseImportFile(text: string, filename: string): ParsedFile {
  const table = tableNameFrom(filename);
  let headers: string[]; let raw: Record<string, string>[];

  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed) as unknown;
    const arr = Array.isArray(json) ? json : [json];
    const keys = new Set<string>();
    for (const o of arr) if (o && typeof o === "object") for (const k of Object.keys(o)) keys.add(k);
    headers = [...keys];
    raw = arr.map(o => {
      const r: Record<string, string> = {};
      for (const k of headers) {
        const val = (o as Record<string, unknown>)?.[k];
        r[k] = val == null ? "" : String(val);
      }
      return r;
    });
  } else {
    const parsed = parseDelimited(text);
    headers = parsed.headers;
    raw = parsed.rows.map(cells => {
      const r: Record<string, string> = {};
      headers.forEach((_, i) => { r[headers[i]!] = cells[i] ?? ""; });
      return r;
    });
  }
  if (headers.length === 0) throw new Error("No columns found — is this a CSV or JSON file?");

  // sanitize + de-duplicate column names, keep a header→ident map
  const idents: string[] = []; const seen = new Set<string>();
  headers.forEach((h, i) => {
    let id = sanitizeIdent(h, `column_${i + 1}`);
    let n = 2; const base = id;
    while (seen.has(id)) id = `${base}_${n++}`;
    seen.add(id); idents.push(id);
  });

  const columns: ImportColumn[] = idents.map((id, i) => {
    const vals = raw.map(r => r[headers[i]!] ?? "");
    return { ...inferType(vals), name: id };
  }).slice(0, 20);   // schema cap (doc: <=20 columns)

  const rows: Record<string, unknown>[] = raw.slice(0, 5000).map(r => {
    const out: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = (r[headers[i]!] ?? "").trim();
      if (v === "") return;
      if (c.type === "number") { const n = cleanNum(v); if (!Number.isNaN(n)) out[c.name] = n; }
      else if (c.type === "date") out[c.name] = isoDate(v);
      else out[c.name] = v;
    });
    return out;
  }).filter(r => Object.keys(r).length > 0);

  return { table, columns, rows };
}
