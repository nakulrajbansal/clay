import { expect } from "vitest";

// Rendered native/ARIA control inventory, not a replacement for browser/axe/NVDA.
// Never reads input values, URLs, storage, or custody. Labels/state only.
const contracts: Record<string, string[][]> = {
  "A.onboarding": [
    ["button", "Import a spreadsheetChoose a CSV or XLSX file, review every accepted, skipped, and limited row, then import.", "enabled"],
    ["button", "Use a recommended starterTracker. A flexible status tracker with ready-to-use views. Projects, tasks, anything with a status", "enabled"],
    ["button", "Change recommendationAnswer one short question to choose a different starter.", "enabled,expanded=false"],
    ["button", "See all templatesChoose a different ready-made starter.", "enabled,expanded=false"],
    ["button", "Advanced optionsOpen an empty app when you want to build it yourself.", "enabled,expanded=false"],
  ],
  "A.workspace": [
    ["button", "Field Service▾", "enabled"], ["button", "Work", "enabled,pressed=false"], ["button", "Customize", "enabled,pressed=true"],
    ["button", "Open Recovery Center", "enabled"], ["button", "Choose situational lens. Current: Workspace", "enabled,expanded=false"],
    ["button", "Open public intake", "enabled"], ["button", "Search and act", "enabled"], ["button", "Open automations", "enabled"],
    ["button", "Open all data", "enabled"], ["button", "Open data shape", "enabled"], ["button", "Choose color scheme", "enabled"], ["button", "Open Ask Clay", "enabled"],
  ],
  // This fixture deliberately lacks trust/restore callbacks: missing prerequisites
  // must remain disabled while the backed-up folder selector can still execute.
  "B.recovery": [
    ["button", "Close Recovery Center", "enabled"], ["button", "Download Recovery Kit", "disabled"],
    ["button", "Check downloaded Recovery Kit", "disabled"], ["button", "Import an existing Recovery Kit", "disabled"],
    ["button", "Use imported series for future backups", "disabled"], ["button", "Retry backup", "disabled"],
    ["button", "Choose backup folder", "enabled"], ["button", "Choose a .clay backup", "disabled"],
    ["button", "Restore as new app (not available yet)", "disabled"],
  ],
  "C.import": [["button", "Go back", "enabled"], ["button", "Import accepted rows (9)", "enabled"]],
  "D.inbox": [
    ["button", "Today", "enabled,pressed=false"], ["button", "Inbox", "enabled,pressed=true"],
    ["button", "↻ Recurring record", "enabled"], ["button", "＋ Quick capture", "enabled"], ["button", "Review setup", "enabled"],
    ["button", "Overdue taxOverdueFavoriteOpened recently", "enabled"], ["button", "Unpin Overdue tax", "enabled"],
    ["button", "Complete", "enabled"], ["textbox", "Snooze Overdue tax until local date", "enabled"],
    ["button", "Snooze", "enabled"], ["button", "Dismiss", "enabled"],
  ],
  "E.automations": [
    ["button", "Close automations", "enabled"], ["button", "Rules 1", "enabled,pressed=true"],
    ["button", "Inbox 0", "enabled,pressed=false"], ["button", "Run history 0", "enabled,pressed=false"],
    ["button", "Set up recipe", "enabled"], ["button", "Build a custom rule", "enabled"], ["button", "Run due schedules now", "enabled"],
    ["switch", "Old reminder needs review", "disabled,checked=false"], ["button", "Review & rebuild", "enabled"], ["button", "Delete Old reminder", "disabled"],
  ],
  "F.share": [
    ["button", "Close share dialog", "enabled"], ["checkbox", "Title", "enabled,checked=true"], ["checkbox", "Status", "enabled,checked=true"],
    ["combobox", "Link expires", "enabled"], ["button", "Cancel", "enabled"], ["button", "Review a fresh snapshot", "enabled"],
    ["button", "Approve this exact scope", "enabled"], ["button", "Create encrypted link", "disabled"],
  ],
  "F.intake": [
    ["button", "Close intake", "enabled"], ["button", "Forms", "enabled,pressed=true"], ["button", "Review inbox", "enabled,pressed=false"],
    ["combobox", "Recipe", "enabled"], ["combobox", "Save accepted answers in", "enabled"], ["textbox", "Form title", "enabled"], ["textbox", "Description", "enabled"],
    ["checkbox", "Customer name", "enabled,checked=true"], ["checkbox", "Supporting document · passive files only · 200,000 bytes", "enabled,checked=true"],
    ["button", "Review form", "enabled"],
  ],
};
function text(node: Node): string {
  if (node instanceof Element && node.matches('[hidden], [aria-hidden="true"], input, textarea, select, svg')) return "";
  return node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : [...node.childNodes].map(text).join("");
}
export function controlCensus(root: ParentNode): string[][] {
  const result: string[][] = [];
  for (const element of root.querySelectorAll<HTMLElement>("button, input, select, textarea, summary, a[href], [role]")) {
    let hidden = element.matches('input[type="hidden"]');
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      hidden ||= parent.hidden || parent.inert || parent.getAttribute("aria-hidden") === "true";
      if (parent.tagName === "DETAILS" && !parent.hasAttribute("open") && !parent.querySelector("summary")?.contains(element)) hidden = true;
    }
    if (hidden) continue;
    const input = element instanceof HTMLInputElement ? element : null;
    const inputRoles: Record<string, string> = { checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", button: "button", submit: "button", file: "button" };
    const tagRoles: Record<string, string> = { BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button", A: "link" };
    const role = element.getAttribute("role") ?? (input ? inputRoles[input.type] ?? "textbox" : tagRoles[element.tagName]);
    if (!role || !["button", "combobox", "textbox", "checkbox", "radio", "slider", "spinbutton", "link", "tab", "switch", "menuitem"].includes(role)) continue;
    const labels = "labels" in element ? (element as HTMLInputElement).labels : null;
    const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map(id => element.ownerDocument.getElementById(id)).filter(n => !!n);
    const name = (labelled?.length ? labelled.map(text).join(" ") : element.getAttribute("aria-label")
      ?? (labels?.length ? [...labels].map(text).join(" ") : ["button", "link", "tab", "menuitem"].includes(role) ? text(element) : ""))
      .replace(/\s+/g, " ").trim();
    const state = [element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" ? "disabled" : "enabled"];
    for (const attribute of ["pressed", "expanded", "selected", "checked"]) {
      const value = element.getAttribute(`aria-${attribute}`); if (value !== null) state.push(`${attribute}=${value}`);
    }
    if (input && ["checkbox", "radio"].includes(input.type)) state.push(`checked=${input.checked}`);
    if (element.tagName === "SUMMARY") state.push(`expanded=${element.parentElement?.hasAttribute("open") ?? false}`);
    result.push([role, name, state.join(",")]);
  }
  return result;
}
export function expectControlCensus(id: string, root: ParentNode = document.body): void {
  expect(contracts[id], `Unknown A–F control census ${id}`).toBeDefined();
  expect(controlCensus(root), id).toEqual(contracts[id]);
}
