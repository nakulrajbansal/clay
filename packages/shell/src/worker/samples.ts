// Sample ("dummy") data generation — trusted worker code, never a panel.
// Rows are inserted through the normal kernel path and their ids recorded in
// the same `sample_rows` setting the template seeder uses, so "clear sample
// data" removes EXACTLY the generated rows (soft-deleted, restorable) and can
// never touch anything the user typed or imported themselves.
import type { ClayStore, RegColumn } from "@clay/kernel";

const PROJECT_NAMES = [
  "Website Redesign", "Mobile App Launch", "Data Platform Migration",
  "Customer Portal", "Checkout Revamp", "Analytics Rollout",
  "Brand Refresh", "Support Automation", "Partner Integration",
  "Security Hardening", "Onboarding Flow", "Inventory Sync",
];
const PEOPLE = [
  "Ava Patel", "Liam Chen", "Maya Rodriguez", "Noah Kim", "Zoe Ahmed",
  "Ethan Brooks", "Ines Fournier", "Ravi Shah", "Sofia Marino", "Jack Nolan",
];
const COMPANIES = [
  "Northwind Traders", "Acme Corp", "Globex", "Initech", "Umbrella Labs",
  "Stark Industries", "Wayne Enterprises", "Hooli", "Vandelay Industries",
];
const OUTCOMES = [
  "Cut onboarding time in half", "Lift conversion by 3pts", "Reduce churn 10%",
  "Launch in two new markets", "Automate weekly reporting", "Free up 20 support hrs/wk",
];
const RISKS = [
  "Vendor contract still unsigned", "Key engineer out next sprint",
  "Scope creep from marketing asks", "Data quality worse than expected",
  "Dependency on platform team", "Budget approval pending",
];
const WINS = [
  "Beta shipped to 50 users", "Signed off design system", "Cut page load 40%",
  "Closed top-3 customer bug", "Hit 99.9% uptime", "First revenue booked",
];
const NOTES = [
  "On plan; next check-in Friday.", "Needs exec decision on scope.",
  "Ahead of schedule.", "Waiting on legal review.", "Watch the burn rate.",
];
const GENERIC_TITLES = [
  "Follow up with vendor", "Prepare quarterly review", "Refresh landing page",
  "Fix billing edge case", "Draft launch email", "Tidy the backlog",
  "Book team offsite", "Update pricing sheet", "Review new applicants",
];
// Domain-aware title pools: matched against the TABLE name so a book
// library gets book titles, not "Fix billing edge case".
const DOMAIN_TITLES: [RegExp, string[]][] = [
  [/book|read|library/, [
    "The Silent Harbor", "A Field Guide to Rivers", "Midnight at the Archive",
    "The Cartographer's Daughter", "On Slow Thinking", "Salt and Starlight",
    "The Last Lighthouse", "Notes from a Small Kitchen"]],
  [/session|talk|event|meeting/, [
    "Opening keynote", "Scaling with small teams", "Design systems that last",
    "The future of local-first", "Panel: shipping weekly", "Lightning talks",
    "Hands-on workshop", "Closing fireside chat"]],
  [/recipe|meal|dish/, [
    "Lemon herb roast chicken", "Weeknight miso ramen", "Skillet cornbread",
    "Slow-cooked ragù", "Summer peach salad", "Overnight oats three ways"]],
  [/song|track|album|playlist/, [
    "Golden Hour", "Static Bloom", "Northbound", "Paper Lanterns",
    "Second Sunrise", "The Quiet Machine"]],
];

const pick = <T>(arr: T[], i: number): T => arr[i % arr.length]!;

function isoOffset(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

/** A plausible value for one column, keyed off its name and type. */
function valueFor(col: RegColumn, i: number, rng: () => number, tableName = ""): unknown {
  const n = col.name.toLowerCase();
  switch (col.type) {
    case "enum": {
      const vals = col.values ?? [];
      if (vals.length === 0) return null;
      // weight toward the first values so boards/branches look alive but uneven
      return vals[Math.floor(rng() * rng() * vals.length)];
    }
    case "number":
    case "integer": {
      const int = col.type === "integer";
      let v: number;
      // spend-side money runs lower than budget-side so utilisation reads sane
      if (/cost|spen[dt]|paid|expense/.test(n)) v = (Math.floor(rng() * 45) + 2) * 1000;
      else if (/budget|revenue|price|amount|value|total/.test(n)) v = (Math.floor(rng() * 90) + 5) * 1000;
      else if (/percent|pct|progress|utili/.test(n)) v = Math.floor(rng() * 101);
      else if (/score|rating|stars/.test(n)) v = Math.floor(rng() * 5) + 1;
      else if (/hours|days|weeks|duration/.test(n)) v = Math.floor(rng() * 39) + 1;
      else if (/qty|quantity|count|stock|units/.test(n)) v = Math.floor(rng() * 48) + 2;
      else v = Math.floor(rng() * 99) + 1;
      return int ? Math.round(v) : v;
    }
    case "date": {
      if (/due|end|target|deadline|until/.test(n)) return isoOffset(3 + Math.floor(rng() * 42));
      if (/start|begin|created|opened|hired|joined/.test(n)) return isoOffset(-(3 + Math.floor(rng() * 60)));
      return isoOffset(Math.floor(rng() * 28) - 14);
    }
    case "boolean":
      return rng() > 0.4;
    case "text": {
      if (/email/.test(n)) return pick(PEOPLE, i).toLowerCase().replace(/[^a-z]+/g, ".") + "@example.com";
      if (/phone/.test(n)) return `(555) 01${i % 10}-${String(1000 + Math.floor(rng() * 9000))}`;
      if (/owner|assignee|manager|lead|contact|person|author|rep/.test(n)) return pick(PEOPLE, i);
      if (/company|client|customer|vendor|account/.test(n)) return pick(COMPANIES, i);
      if (/outcome|goal|objective/.test(n)) return pick(OUTCOMES, i);
      if (/risk|blocker|issue/.test(n)) return pick(RISKS, i);
      if (/win|highlight|achievement/.test(n)) return pick(WINS, i);
      if (/note|description|summary|detail|comment/.test(n)) return pick(NOTES, i);
      if (/project|initiative|epic|campaign/.test(n)) return pick(PROJECT_NAMES, i);
      if (/name|title|subject|task|item|label/.test(n)) {
        for (const [re, pool] of DOMAIN_TITLES)
          if (re.test(tableName)) return pick(pool, i);
        return pick(n.includes("name") && !/project/.test(n) && rng() > 0.5 ? PROJECT_NAMES : GENERIC_TITLES, i);
      }
      if (/city|location|office/.test(n)) return pick(["Austin", "Berlin", "Toronto", "Singapore", "London"], i);
      return `Sample ${col.name} ${i + 1}`;
    }
    default:   // json, computed — never write
      return undefined;
  }
}

const ROWS_PER_TABLE = 8;

/** Fill every table with plausible rows, tracked in the sample_rows marker.
 * Returns per-table counts. Deterministic-ish but varied (seeded LCG). */
export function fillSampleRows(store: ClayStore): { added: number; tables: number } {
  let seed = 42;
  const rng = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const marker = store.getSetting<Record<string, string[]>>("sample_rows") ?? {};
  let added = 0; let tableCount = 0;
  for (const table of store.registrySnapshot().values()) {
    // History must reflect real moves, never invented ones: skip audit
    // tables (activity/log/history names, or a from_stage/to_stage pair) —
    // they fill themselves as the user advances items.
    const names = new Set(table.columns.map(c => c.name));
    if (/(activity|_log|_history)$/.test(table.name)
        || (names.has("from_stage") && names.has("to_stage"))) continue;
    const writable = table.columns.filter(c =>
      c.type !== "computed" && c.type !== "json" && !c.hidden);
    if (writable.length === 0) continue;
    const ids: string[] = marker[table.name] ?? [];
    for (let i = 0; i < ROWS_PER_TABLE; i++) {
      const row: Record<string, unknown> = {};
      for (const c of writable) {
        const v = valueFor(c, i + Math.floor(rng() * 3), rng, table.name);
        if (v !== undefined && v !== null) row[c.name] = v;
      }
      try {
        ids.push(String(store.insert(table.name, row).id));
        added++;
      } catch { /* required/validation mismatch on odd schemas — skip row */ }
    }
    if (ids.length > 0) { marker[table.name] = ids; tableCount++; }
  }
  store.setSetting("sample_rows", marker);
  return { added, tables: tableCount };
}

/** How many tracked sample rows currently exist (drives the Clear button). */
export function sampleRowCount(store: ClayStore): number {
  const marker = store.getSetting<Record<string, string[]>>("sample_rows") ?? {};
  return Object.values(marker).reduce((s, ids) => s + ids.length, 0);
}
