// The multi-app switcher (G4): a header bar to switch between apps, create
// a new one, or delete the current one. Switching is reload-based (App
// handles the reload); this is just the chrome. Also hosts a theme
// quick-switch (palette popover) on the right.
import { useRef, useState } from "react";
import type { AppEntry } from "./apps";
import type { Theme } from "./themes";
import { isSavedLensId, type LensId, type SituationalLens } from "./lenses";
import { ModalDialog } from "./ModalDialog";
import type { WorkspaceMode } from "./workspace-mode";

export function AppSwitcher(props: {
  apps: AppEntry[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onFork: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onOpenSearch: () => void;
  onOpenAutomations: () => void;
  unreadNotifications: number;
  onOpenData: () => void;
  onOpenShapeMap: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  version: number;
  persistent: boolean;
  themes: Theme[];
  themeId: string;
  onSelectTheme: (id: string) => void;
  lenses: SituationalLens[];
  lensId: LensId;
  lensReady: boolean;
  onSelectLens: (id: LensId) => void;
  onSaveLens: (name: string) => Promise<void>;
  onDeleteLens: (id: LensId) => Promise<void>;
  workspaceMode: WorkspaceMode;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [themeOpen, setThemeOpen] = useState(false);
  const [lensOpen, setLensOpen] = useState(false);
  const [savingLens, setSavingLens] = useState(false);
  const [lensDraft, setLensDraft] = useState("");
  const [confirmDeleteLens, setConfirmDeleteLens] = useState<LensId | null>(null);
  const lensButtonRef = useRef<HTMLButtonElement>(null);
  const firstLensRef = useRef<HTMLButtonElement>(null);
  const lensItemRefs = useRef(new Map<LensId, HTMLButtonElement>());
  const current = props.apps.find(a => a.id === props.currentId) ?? null;
  const currentTheme = props.themes.find(t => t.id === props.themeId) ?? props.themes[0]!;
  const currentLens = props.lenses.find(lens => lens.id === props.lensId) ?? props.lenses[0]!;
  const startRename = (): void => { if (current) { setDraft(current.name); setRenaming(true); } };
  const saveRename = (): void => {
    if (current && draft.trim()) props.onRename(current.id, draft.trim());
    setRenaming(false); setOpen(false);
  };
  const closeLens = (restoreFocus = true): void => {
    setLensOpen(false); setSavingLens(false); setConfirmDeleteLens(null);
    if (restoreFocus) lensButtonRef.current?.focus();
  };
  const selectLens = (id: LensId): void => { props.onSelectLens(id); closeLens(); };
  const saveLens = async (): Promise<void> => {
    const name = lensDraft.trim();
    if (!name) return;
    await props.onSaveLens(name);
    setLensDraft(""); closeLens();
  };
  const deleteLens = async (id: LensId): Promise<void> => {
    await props.onDeleteLens(id); closeLens();
  };

  return (
    <header className="appbar">
      <span className="appbar-brand"><span className="appbar-mark" aria-hidden="true" />Clay</span>
      <div className="appbar-switch">
        <button className="appbar-current" onClick={() => setOpen(o => !o)}>
          {current ? current.name : "My app"}
          <span className="appbar-caret">▾</span>
        </button>
        {open ? (
          <>
            <div className="appbar-backdrop" onClick={() => setOpen(false)} />
            <div className="appbar-menu">
              {props.apps.map(a => (
                <button
                  key={a.id}
                  className={`appbar-item${a.id === props.currentId ? " current" : ""}`}
                  onClick={() => { setOpen(false); if (a.id !== props.currentId) props.onSwitch(a.id); }}
                >
                  {a.name}
                  {a.id === props.currentId ? <span className="appbar-check">✓</span> : null}
                </button>
              ))}
              <div className="appbar-sep" />
              {current ? (
                renaming ? (
                  <div className="appbar-rename">
                    <input
                      autoFocus
                      value={draft}
                      maxLength={40}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") setRenaming(false);
                      }}
                    />
                    <button className="appbar-item-inline" onClick={saveRename}>Save</button>
                  </div>
                ) : (
                  <button className="appbar-item" onClick={startRename}>
                    Rename “{current.name}”
                  </button>
                )
              ) : null}
              <button className="appbar-item" onClick={() => { setOpen(false); props.onNew(); }}>
                + New app
              </button>
              {current ? (
                <button className="appbar-item" onClick={() => { setOpen(false); props.onFork(); }}>
                  Duplicate “{current.name}”
                </button>
              ) : null}
              {current ? (
                <button
                  className="appbar-item danger"
                  onClick={() => { setOpen(false); props.onDelete(current.id); }}
                >
                  Delete “{current.name}”
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <div className="appbar-mode" role="group" aria-label="Workspace mode">
        {(["work", "customize"] as const).map(mode => (
          <button key={mode}
            className={`appbar-mode-button${props.workspaceMode === mode ? " active" : ""}`}
            aria-pressed={props.workspaceMode === mode}
            onClick={() => props.onWorkspaceModeChange(mode)}>
            {mode === "work" ? "Work" : "Customize"}
          </button>
        ))}
      </div>

      <span className={`appbar-trust${props.persistent ? "" : " appbar-trust-warn"}`}>
        <span className="appbar-trust-dot" aria-hidden="true" />
        {props.persistent ? "Stored on this device" : "Temporary session"} · v{props.version}
      </span>
      <div className="appbar-lens">
        <button
          ref={lensButtonRef}
          className={`appbar-action appbar-lens-btn${props.lensId === "all" ? "" : " active"}`}
          aria-label={`Choose situational lens. Current: ${currentLens.name}`}
          aria-expanded={lensOpen}
          aria-haspopup="dialog"
          title="Change which views are visible without changing your data"
          onClick={() => { setOpen(false); setThemeOpen(false); setLensOpen(value => !value); }}
        >
          <span className="appbar-action-icon" aria-hidden="true">◉</span>
          <span className="appbar-action-label">{currentLens.name}</span>
        </button>
        {lensOpen ? (
          <ModalDialog className="appbar-lens-menu"
            backdropClassName="appbar-backdrop appbar-lens-backdrop"
            ariaLabel="Situational lenses" onClose={() => closeLens()}
            returnFocusRef={lensButtonRef}>
              <span className="appbar-menu-label">Same data, different moment</span>
              {props.lenses.map((lens, index) => (
                <div key={lens.id} className="appbar-lens-row">
                  <button
                    ref={element => {
                      if (element) lensItemRefs.current.set(lens.id, element);
                      else lensItemRefs.current.delete(lens.id);
                      if (index === 0) firstLensRef.current = element;
                    }}
                    aria-pressed={lens.id === props.lensId}
                    disabled={lens.id !== "all" && lens.panelIds.length === 0}
                    autoFocus={index === 0}
                    className={`appbar-lens-item${lens.id === props.lensId ? " selected" : ""}`}
                    onClick={() => selectLens(lens.id)}>
                    <span><b>{lens.name}</b><small>{lens.description}</small></span>
                    <em>{lens.capturedCount === undefined
                      ? lens.panelIds.length : `${lens.panelIds.length}/${lens.capturedCount}`}</em>
                  </button>
                  {props.workspaceMode === "customize" && isSavedLensId(lens.id) ? (
                    confirmDeleteLens === lens.id ? (
                      <div className="appbar-lens-delete-confirm" role="group"
                        aria-label={`Confirm delete lens ${lens.name}`}
                        onKeyDown={event => {
                          if (event.key !== "Escape") return;
                          event.preventDefault(); event.stopPropagation();
                          setConfirmDeleteLens(null);
                          lensItemRefs.current.get(lens.id)?.focus();
                        }}>
                        <button autoFocus className="danger" onClick={() => void deleteLens(lens.id)}>Delete</button>
                        <button onClick={() => {
                          setConfirmDeleteLens(null);
                          lensItemRefs.current.get(lens.id)?.focus();
                        }}>Cancel</button>
                      </div>
                    ) : (
                      <button className="appbar-lens-delete"
                        aria-label={`Delete lens ${lens.name}`}
                        onClick={() => setConfirmDeleteLens(lens.id)}>×</button>
                    )
                  ) : null}
                </div>
              ))}
              {props.workspaceMode === "customize" ? (savingLens ? (
                <div className="appbar-lens-save">
                  <input autoFocus value={lensDraft} maxLength={40}
                    aria-label="Saved lens name" placeholder="Lens name"
                    onChange={event => setLensDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter" && lensDraft.trim()) {
                        void saveLens();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault(); event.stopPropagation();
                        setSavingLens(false);
                        firstLensRef.current?.focus();
                      }
                    }} />
                  <button disabled={!lensDraft.trim()}
                    onClick={() => void saveLens()}>
                    Save
                  </button>
                </div>
              ) : (
                <button className="appbar-lens-create" disabled={!props.lensReady}
                  title={props.lensReady ? undefined : "Saved lenses are still loading"}
                  onClick={() => setSavingLens(true)}>
                  + Save current view
                </button>
              )) : null}
          </ModalDialog>
        ) : null}
      </div>
      <button
        className="appbar-action appbar-search-btn"
        aria-label="Search and act"
        title="Find any record or run a quick action (Ctrl+K)"
        onClick={props.onOpenSearch}
      >
        <span className="appbar-action-icon" aria-hidden="true">⌕</span>
        <span className="appbar-action-label">Search</span>
        <kbd className="appbar-shortcut">Ctrl K</kbd>
      </button>
      {props.workspaceMode === "customize" ? <>
      <button
        className="appbar-action appbar-automation-btn"
        aria-label="Open automations"
        title="Build rules, reminders, and repeatable actions"
        onClick={props.onOpenAutomations}
      >
        <span className="appbar-action-icon" aria-hidden="true">↻</span>
        <span className="appbar-action-label">Automate</span>
        {props.unreadNotifications > 0 ? (
          <span className="appbar-notification-count" aria-label={`${props.unreadNotifications} unread reminders`}>
            {Math.min(99, props.unreadNotifications)}
          </span>
        ) : null}
      </button>
      <button
        className="appbar-action appbar-data-btn"
        aria-label="Open data"
        title="See, edit, and import your data"
        onClick={props.onOpenData}
      >
        <span className="appbar-action-icon" aria-hidden="true">▦</span>
        <span className="appbar-action-label">Data</span>
      </button>
      <button
        className="appbar-action appbar-shape-btn"
        aria-label="Open shape map"
        title="See how your data, views, and history connect"
        onClick={props.onOpenShapeMap}
      >
        <span className="appbar-action-icon" aria-hidden="true">⌘</span>
        <span className="appbar-action-label">Shape map</span>
      </button>
      <div className="appbar-theme">
        <button
          className="appbar-theme-btn"
          aria-label="Choose color scheme"
          title="Color scheme"
          onClick={() => setThemeOpen(o => !o)}
        >
          <span className="appbar-theme-dot" style={{ background: currentTheme.vars.accent }} />
          <span className="appbar-action-label">Theme</span>
        </button>
        {themeOpen ? (
          <>
            <div className="appbar-backdrop" onClick={() => setThemeOpen(false)} />
            <div className="appbar-theme-menu">
              {props.themes.map(t => (
                <button
                  key={t.id}
                  className={`theme-swatch${t.id === props.themeId ? " selected" : ""}`}
                  title={t.name}
                  onClick={() => { props.onSelectTheme(t.id); setThemeOpen(false); }}
                  style={{ background: t.vars.bg, color: t.vars.text, borderColor: t.vars.borderStrong }}
                >
                  <span className="theme-dot" style={{ background: t.vars.accent }} />
                  <span className="theme-name">{t.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <button
        className={`appbar-rail-toggle${props.railOpen ? " active" : ""}`}
        aria-label={props.railOpen ? "Hide reshape" : "Show reshape"}
        title={props.railOpen ? "Hide reshape" : "Show reshape"}
        onClick={props.onToggleRail}
      >
        <span aria-hidden="true">{props.railOpen ? "◧" : "◨"}</span>
      </button>
      </> : null}
    </header>
  );
}
