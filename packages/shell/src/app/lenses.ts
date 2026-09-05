import type { LivePanel, PanelProvenance } from "@clay/kernel";

export const BUILT_IN_LENS_IDS = ["all", "review", "focus", "update"] as const;

export type BuiltInLensId = typeof BUILT_IN_LENS_IDS[number];
export type SavedLensId = `saved:${string}`;
export type LensId = BuiltInLensId | SavedLensId;

const BUILT_IN_LENS_ID_SET = new Set<string>(BUILT_IN_LENS_IDS);
const SAVED_LENS_ID_PATTERN = /^saved:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isBuiltInLensId(value: unknown): value is BuiltInLensId {
  return typeof value === "string" && BUILT_IN_LENS_ID_SET.has(value);
}

export function isSavedLensId(value: unknown): value is SavedLensId {
  return typeof value === "string" && SAVED_LENS_ID_PATTERN.test(value);
}

export type LensPlacement = {
  region: "top" | "main" | "side";
  order: number;
  w?: 1 | 2 | 3 | 4;
  h?: number;
  col?: 0 | 1 | 2 | 3;
};

export type LensFilterValue =
  | string
  | number
  | boolean
  | null
  | { from: string; to: string };

export type LensFilterSnapshot = {
  signature: string;
  state: Record<string, LensFilterValue>;
};

export type SavedLensPanel = {
  panelId: string;
  createdVersion: number;
  createdAt?: string;
  placement: LensPlacement;
  filters: Record<string, LensFilterSnapshot>;
};

export type SavedLens = {
  id: SavedLensId;
  name: string;
  createdAt: string;
  updatedAt: string;
  capturedAtVersion: number;
  panels: SavedLensPanel[];
};

export type SavedLensLibraryV1 = {
  format: 1;
  revision: number;
  lenses: SavedLens[];
};

export const SAVED_LENS_SETTING_KEY = "situational_lenses_v1";

export const SAVED_LENS_LIMITS = Object.freeze({
  lenses: 24,
  nameCodePoints: 40,
  panelsPerLens: 40,
  filterControlsPerPanel: 8,
  filterFieldsPerPanel: 32,
  scalarStringCodePoints: 512,
  filterBytesPerLens: 16 * 1024,
});

const PANEL_ID_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export function emptySavedLensLibrary(): SavedLensLibraryV1 {
  return { format: 1, revision: 0, lenses: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && codePointLength(value) <= maximum
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

function parseLensName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return boundedString(name, SAVED_LENS_LIMITS.nameCodePoints, false) ? name : null;
}

function parseTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64
    && Number.isFinite(Date.parse(value)) ? value : null;
}

function parsePlacement(value: unknown): LensPlacement | null {
  if (!isRecord(value)) return null;
  const region = value.region;
  if (region !== "top" && region !== "main" && region !== "side") return null;
  if (!boundedInteger(value.order, 0, 50)) return null;
  const placement: LensPlacement = { region, order: value.order };
  if (Object.hasOwn(value, "w")) {
    if (!boundedInteger(value.w, 1, 4)) return null;
    placement.w = value.w as 1 | 2 | 3 | 4;
  }
  if (Object.hasOwn(value, "h")) {
    if (!boundedInteger(value.h, 80, 2000)) return null;
    placement.h = value.h;
  }
  if (Object.hasOwn(value, "col")) {
    if (!boundedInteger(value.col, 0, 3)) return null;
    placement.col = value.col as 0 | 1 | 2 | 3;
  }
  return placement;
}

function parseFilterValue(value: unknown): LensFilterValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return codePointLength(value) <= SAVED_LENS_LIMITS.scalarStringCodePoints
      ? value : undefined;
  }
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string")
    return undefined;
  if (codePointLength(value.from) > SAVED_LENS_LIMITS.scalarStringCodePoints
      || codePointLength(value.to) > SAVED_LENS_LIMITS.scalarStringCodePoints) return undefined;
  return { from: value.from, to: value.to };
}

function parseFilters(value: unknown): Record<string, LensFilterSnapshot> | null {
  if (!isRecord(value)) return null;
  const controls = Object.entries(value);
  if (controls.length > SAVED_LENS_LIMITS.filterControlsPerPanel) return null;
  let fieldCount = 0;
  const filters: Record<string, LensFilterSnapshot> = {};
  for (const [controlId, candidate] of controls) {
    if (!boundedString(controlId, SAVED_LENS_LIMITS.scalarStringCodePoints, false)
        || !isRecord(candidate)
        || !boundedString(candidate.signature, SAVED_LENS_LIMITS.scalarStringCodePoints, false)
        || !isRecord(candidate.state)) return null;
    const stateEntries = Object.entries(candidate.state);
    fieldCount += stateEntries.length;
    if (fieldCount > SAVED_LENS_LIMITS.filterFieldsPerPanel) return null;
    const stateEntriesParsed: Array<[string, LensFilterValue]> = [];
    for (const [field, rawValue] of stateEntries) {
      if (!boundedString(field, SAVED_LENS_LIMITS.scalarStringCodePoints, false)) return null;
      const parsedValue = parseFilterValue(rawValue);
      if (parsedValue === undefined) return null;
      stateEntriesParsed.push([field, parsedValue]);
    }
    filters[controlId] = {
      signature: candidate.signature,
      state: Object.fromEntries(stateEntriesParsed),
    };
  }
  return filters;
}

function parseSavedLensPanel(value: unknown): SavedLensPanel | null {
  if (!isRecord(value) || typeof value.panelId !== "string"
      || !PANEL_ID_PATTERN.test(value.panelId)
      || !boundedInteger(value.createdVersion, 0, Number.MAX_SAFE_INTEGER)) return null;
  const createdAt = value.createdAt === undefined ? undefined : parseTimestamp(value.createdAt);
  const placement = parsePlacement(value.placement);
  const filters = parseFilters(value.filters);
  if ((value.createdAt !== undefined && !createdAt) || !placement || !filters) return null;
  return {
    panelId: value.panelId,
    createdVersion: value.createdVersion,
    ...(createdAt ? { createdAt } : {}),
    placement,
    filters,
  };
}

function parseSavedLens(value: unknown): SavedLens | null {
  if (!isRecord(value) || !isSavedLensId(value.id)) return null;
  const name = parseLensName(value.name);
  const createdAt = parseTimestamp(value.createdAt);
  const updatedAt = parseTimestamp(value.updatedAt);
  if (!name || !createdAt || !updatedAt
      || !boundedInteger(value.capturedAtVersion, 0, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(value.panels)
      || value.panels.length > SAVED_LENS_LIMITS.panelsPerLens) return null;
  const panels: SavedLensPanel[] = [];
  const panelIds = new Set<string>();
  for (const rawPanel of value.panels) {
    const parsedPanel = parseSavedLensPanel(rawPanel);
    if (!parsedPanel || panelIds.has(parsedPanel.panelId)) return null;
    panelIds.add(parsedPanel.panelId);
    panels.push(parsedPanel);
  }
  const filterBytes = new TextEncoder().encode(JSON.stringify(
    panels.map(panel => panel.filters),
  )).byteLength;
  if (filterBytes > SAVED_LENS_LIMITS.filterBytesPerLens) return null;
  return {
    id: value.id,
    name,
    createdAt,
    updatedAt,
    capturedAtVersion: value.capturedAtVersion,
    panels,
  };
}

export type SavedLensLibraryValidation = {
  status: "missing" | "valid" | "partial" | "invalid";
  library: SavedLensLibraryV1;
  droppedLensCount: number;
};

export function validateSavedLensLibrary(value: unknown): SavedLensLibraryValidation {
  if (value === null || value === undefined || value === "") {
    return { status: "missing", library: emptySavedLensLibrary(), droppedLensCount: 0 };
  }
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; }
    catch {
      return { status: "invalid", library: emptySavedLensLibrary(), droppedLensCount: 0 };
    }
  }
  if (!isRecord(candidate) || candidate.format !== 1
      || !boundedInteger(candidate.revision, 0, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(candidate.lenses)
      || candidate.lenses.length > SAVED_LENS_LIMITS.lenses) {
    return { status: "invalid", library: emptySavedLensLibrary(), droppedLensCount: 0 };
  }
  const lenses: SavedLens[] = [];
  const ids = new Set<SavedLensId>();
  const names = new Set<string>();
  let droppedLensCount = 0;
  for (const rawLens of candidate.lenses) {
    const lens = parseSavedLens(rawLens);
    const nameKey = lens?.name.toLowerCase();
    if (!lens || ids.has(lens.id) || (nameKey !== undefined && names.has(nameKey))) {
      droppedLensCount++;
      continue;
    }
    ids.add(lens.id);
    names.add(nameKey!);
    lenses.push(lens);
  }
  return {
    status: droppedLensCount > 0 ? "partial" : "valid",
    library: { format: 1, revision: candidate.revision, lenses },
    droppedLensCount,
  };
}

export function loadSavedLensLibrary(value: unknown): SavedLensLibraryV1 {
  return validateSavedLensLibrary(value).library;
}

export type SavedLensNameValidation =
  | { ok: true; name: string }
  | { ok: false; code: "required" | "too_long" | "control" | "duplicate"; message: string };

export type SavedLensErrorCode =
  | "invalid_library"
  | "invalid_id"
  | "built_in"
  | "missing"
  | "duplicate_id"
  | "duplicate_name"
  | "limit"
  | "invalid_lens";

export class SavedLensError extends Error {
  constructor(readonly code: SavedLensErrorCode, message: string) {
    super(message);
    this.name = "SavedLensError";
  }
}

export function createSavedLensId(
  randomUUID: () => string = () => crypto.randomUUID(),
): SavedLensId {
  const id = `saved:${randomUUID()}`;
  if (!isSavedLensId(id)) {
    throw new SavedLensError("invalid_id", "The generated saved-lens id is not a UUID.");
  }
  return id;
}

export function validateSavedLensName(
  value: unknown,
  library: Pick<SavedLensLibraryV1, "lenses">,
  exceptId?: SavedLensId,
): SavedLensNameValidation {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, code: "required", message: "Enter a lens name." };
  }
  const name = value.trim();
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return { ok: false, code: "control", message: "Lens names cannot contain control characters." };
  }
  if (codePointLength(name) > SAVED_LENS_LIMITS.nameCodePoints) {
    return {
      ok: false,
      code: "too_long",
      message: `Lens names can contain at most ${SAVED_LENS_LIMITS.nameCodePoints} characters.`,
    };
  }
  const key = name.toLowerCase();
  if (library.lenses.some(lens => lens.id !== exceptId && lens.name.toLowerCase() === key)) {
    return { ok: false, code: "duplicate", message: "Lens names must be unique." };
  }
  return { ok: true, name };
}

function canonicalLibraryForWrite(library: SavedLensLibraryV1): SavedLensLibraryV1 {
  const result = validateSavedLensLibrary(library);
  if (result.status !== "valid" || result.library.lenses.length !== library.lenses.length) {
    throw new SavedLensError("invalid_library", "The saved-lens library is invalid.");
  }
  return result.library;
}

function incrementRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new SavedLensError("invalid_library", "The saved-lens library revision is exhausted.");
  }
  return revision + 1;
}

function assertMutableSavedId(id: LensId | string): asserts id is SavedLensId {
  if (isBuiltInLensId(id)) {
    throw new SavedLensError("built_in", "Built-in lenses cannot be changed or deleted.");
  }
  if (!isSavedLensId(id)) {
    throw new SavedLensError("invalid_id", "The saved-lens id is invalid.");
  }
}

function lensNameOrThrow(
  name: unknown,
  library: SavedLensLibraryV1,
  exceptId?: SavedLensId,
): string {
  const result = validateSavedLensName(name, library, exceptId);
  if (result.ok) return result.name;
  throw new SavedLensError(
    result.code === "duplicate" ? "duplicate_name" : "invalid_lens",
    result.message,
  );
}

export function addSavedLens(
  library: SavedLensLibraryV1,
  lens: SavedLens,
): SavedLensLibraryV1 {
  const current = canonicalLibraryForWrite(library);
  if (current.lenses.length >= SAVED_LENS_LIMITS.lenses) {
    throw new SavedLensError("limit", "This app already has the maximum number of saved lenses.");
  }
  if (current.lenses.some(item => item.id === lens.id)) {
    throw new SavedLensError("duplicate_id", "That saved-lens id is already in use.");
  }
  const name = lensNameOrThrow(lens.name, current);
  const parsed = parseSavedLens({ ...lens, name });
  if (!parsed) throw new SavedLensError("invalid_lens", "The saved lens is invalid.");
  return {
    format: 1,
    revision: incrementRevision(current.revision),
    lenses: [...current.lenses, parsed],
  };
}

/** Alias used by callers that name the create operation explicitly. */
export const createSavedLens = addSavedLens;

export type SavedLensUpdate = Pick<
  SavedLens,
  "name" | "updatedAt" | "capturedAtVersion" | "panels"
>;

export function updateSavedLens(
  library: SavedLensLibraryV1,
  id: LensId | string,
  update: SavedLensUpdate,
): SavedLensLibraryV1 {
  assertMutableSavedId(id);
  const current = canonicalLibraryForWrite(library);
  const index = current.lenses.findIndex(lens => lens.id === id);
  const existing = current.lenses[index];
  if (!existing) throw new SavedLensError("missing", "The saved lens no longer exists.");
  const name = lensNameOrThrow(update.name, current, id);
  const parsed = parseSavedLens({
    id,
    name,
    createdAt: existing.createdAt,
    updatedAt: update.updatedAt,
    capturedAtVersion: update.capturedAtVersion,
    panels: update.panels,
  });
  if (!parsed) throw new SavedLensError("invalid_lens", "The saved lens update is invalid.");
  const lenses = [...current.lenses];
  lenses[index] = parsed;
  return { format: 1, revision: incrementRevision(current.revision), lenses };
}

export function renameSavedLens(
  library: SavedLensLibraryV1,
  id: LensId | string,
  name: string,
  updatedAt: string,
): SavedLensLibraryV1 {
  assertMutableSavedId(id);
  const current = canonicalLibraryForWrite(library);
  const existing = current.lenses.find(lens => lens.id === id);
  if (!existing) throw new SavedLensError("missing", "The saved lens no longer exists.");
  return updateSavedLens(current, id, {
    name,
    updatedAt,
    capturedAtVersion: existing.capturedAtVersion,
    panels: existing.panels,
  });
}

export type DeleteSavedLensResult = {
  library: SavedLensLibraryV1;
  deleted: SavedLens;
};

export function deleteSavedLens(
  library: SavedLensLibraryV1,
  id: LensId | string,
): DeleteSavedLensResult {
  assertMutableSavedId(id);
  const current = canonicalLibraryForWrite(library);
  const index = current.lenses.findIndex(lens => lens.id === id);
  const deleted = current.lenses[index];
  if (!deleted) throw new SavedLensError("missing", "The saved lens no longer exists.");
  return {
    library: {
      format: 1,
      revision: incrementRevision(current.revision),
      lenses: current.lenses.filter(lens => lens.id !== id),
    },
    deleted,
  };
}

export type SituationalLens = {
  id: LensId;
  name: string;
  description: string;
  panelIds: string[];
  capturedCount?: number;
  staleCount?: number;
  saved?: SavedLens;
};

const LENS_IDS = new Set<LensId>(["all", "review", "focus", "update"]);

export function buildSituationalLenses(
  panels: LivePanel[], saved: SavedLens[] = [],
): SituationalLens[] {
  const ids = (predicate: (panel: LivePanel) => boolean): string[] =>
    panels.filter(predicate).map(panel => panel.panel_id);
  const builtIns: SituationalLens[] = [
    {
      id: "all",
      name: "Workspace",
      description: "Your complete workspace",
      panelIds: ids(() => true),
    },
    {
      id: "review",
      name: "Morning review",
      description: "Read-only signals and summaries",
      panelIds: ids(panel => panel.declared_writes.length === 0),
    },
    {
      id: "focus",
      name: "Focus",
      description: "The primary work canvas",
      panelIds: ids(panel => panel.placement.region === "main"),
    },
    {
      id: "update",
      name: "Update data",
      description: "Forms and views that can change records",
      panelIds: ids(panel => panel.declared_writes.length > 0),
    },
  ];
  return [...builtIns, ...saved.map(lens => ({
    id: lens.id, name: lens.name, description: "Saved view and layout",
    panelIds: lens.panels.map(panel => panel.panelId), saved: lens,
  }))];
}

export function applyLens(
  panels: LivePanel[], id: string, saved: SavedLens[] = [],
): LivePanel[] {
  const lens = buildSituationalLenses(panels, saved).find(item => item.id === id);
  if (!lens) return panels;
  const visible = new Set(lens.panelIds);
  return panels.filter(panel => visible.has(panel.panel_id));
}

export function captureSavedLens(input: {
  name: string; panels: LivePanel[]; provenance: PanelProvenance[];
  version: number; now?: string; randomUUID?: () => string;
}): SavedLens {
  const now = input.now ?? new Date().toISOString();
  const provenance = new Map(input.provenance.map(item => [item.panel_id, item]));
  return {
    id: createSavedLensId(input.randomUUID), name: input.name,
    createdAt: now, updatedAt: now, capturedAtVersion: input.version,
    panels: input.panels.map(panel => {
      const origin = provenance.get(panel.panel_id);
      if (!origin) {
        throw new SavedLensError("invalid_lens",
          `Provenance is not ready for the “${panel.title}” panel.`);
      }
      const placement: LensPlacement = {
        region: panel.placement.region, order: Math.max(0, Math.min(50, panel.placement.order)),
      };
      const width = panel.placement.w;
      if (width === 1 || width === 2 || width === 3 || width === 4) placement.w = width;
      const height = panel.placement.h;
      if (height !== undefined && height >= 80 && height <= 2000) placement.h = Math.round(height);
      const col = panel.placement.col;
      if (col === 0 || col === 1 || col === 2 || col === 3) placement.col = col;
      return {
        panelId: panel.panel_id,
        createdVersion: origin.createdVersion,
        createdAt: origin.createdAt,
        placement, filters: {},
      };
    }),
  };
}

export function applySavedLensLayout(
  panels: LivePanel[], lens: SavedLens, provenance: PanelProvenance[],
): LivePanel[] {
  const byId = new Map(panels.map(panel => [panel.panel_id, panel]));
  const creation = new Map(provenance.map(item => [item.panel_id, {
    version: item.createdVersion, at: item.createdAt,
  }]));
  return [...lens.panels]
    .sort((left, right) => left.placement.order - right.placement.order
      || left.panelId.localeCompare(right.panelId))
    .flatMap(saved => {
      const panel = byId.get(saved.panelId);
      const origin = creation.get(saved.panelId);
      if (!panel || origin?.version !== saved.createdVersion
          || (saved.createdAt !== undefined && origin.at !== saved.createdAt)) return [];
      return [{ ...panel, placement: { ...saved.placement } }];
    });
}

const lensKey = (appId: string): string => `clay_lens_${appId}`;

export function loadLensId(
  storage: Pick<Storage, "getItem">,
  appId: string,
): LensId {
  try {
    const value = storage.getItem(lensKey(appId));
    return value && (LENS_IDS.has(value as LensId) || isSavedLensId(value))
      ? value as LensId : "all";
  } catch { return "all"; }
}

export function saveLensId(
  storage: Pick<Storage, "setItem">,
  appId: string,
  id: LensId,
): void {
  try { storage.setItem(lensKey(appId), id); } catch { /* private mode */ }
}
