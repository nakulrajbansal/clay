import { FocusInput, FocusButton } from "./FocusControl";
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
  onOpenIntake?: () => void;
  unreadNotifications: number;
  onOpenData: () => void;
  onOpenShapeMap: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  version: number;
  persistent: boolean;
  onOpenRecovery: () => void;
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
    <header className="ui ui-display-flex ui-align-items-center ui-background-panel ui-flex-none ui-border-bottom-line ui-gap-10px ui-position-relative appbar" data-workspace-mode={props.workspaceMode}>
      <span className="ui ui-align-items-center ui-color-text ui-display-inline-flex ui-gap-9px appbar-brand"><span className="ui ui-background-accent appbar-mark" aria-hidden="true" />Clay</span>
      <div className="ui ui-position-relative appbar-switch">
        <button className="ui ui-display-flex ui-align-items-center ui-background-panel ui-base-border-8f9f0d ui-font-inherit ui-gap-7px appbar-current" onClick={() => setOpen(o => !o)}>
          {current ? current.name : "My app"}
          <span className="ui ui-color-text-3 ui-font-size-11px appbar-caret">▾</span>
        </button>
        {open ? (
          <>
            <div className="ui ui-position-fixed ui-inset-0 appbar-backdrop" onClick={() => setOpen(false)} />
            <div className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-8f9f0d ui-base-border-radius-25b77c ui-box-shadow-shadow-lg ui-position-absolute appbar-menu">
              {props.apps.map(a => (
                <button
                  key={a.id}
                  className={`ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-color-text ui-border-0 ui-border-radius-8px ui-text-align-left ui-font-inherit ui-background-none appbar-item${a.id === props.currentId ? " current" : ""}`}
                  onClick={() => { setOpen(false); if (a.id !== props.currentId) props.onSwitch(a.id); }}
                >
                  {a.name}
                  {a.id === props.currentId ? <span className="ui ui-color-accent appbar-check">✓</span> : null}
                </button>
              ))}
              <div className="appbar-sep" />
              {current ? (
                renaming ? (
                  <div className="ui ui-display-flex ui-align-items-center ui-gap-6px ui-inputfocus-outline-89c3b3 ui-inputfocus-box-shadow-0cf866 ui-input-font-648ad9 ui-input-border-radius-9af632 ui-input-min-width-39910f appbar-rename">
                    <FocusInput
                      autoFocus
                      value={draft}
                      maxLength={40}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") setRenaming(false);
                      }}
                    />
                    <button className="ui ui-border-0 ui-border-radius-8px ui-font-inherit ui-background-accent appbar-item-inline" onClick={saveRename}>Save</button>
                  </div>
                ) : (
                  <button className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-color-text ui-border-0 ui-border-radius-8px ui-text-align-left ui-font-inherit ui-background-none appbar-item" onClick={startRename}>
                    Rename “{current.name}”
                  </button>
                )
              ) : null}
              <button className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-color-text ui-border-0 ui-border-radius-8px ui-text-align-left ui-font-inherit ui-background-none appbar-item" onClick={() => { setOpen(false); props.onNew(); }}>
                + New app
              </button>
              {current ? (
                <button className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-color-text ui-border-0 ui-border-radius-8px ui-text-align-left ui-font-inherit ui-background-none appbar-item" onClick={() => { setOpen(false); props.onFork(); }}>
                  Duplicate “{current.name}”
                </button>
              ) : null}
              {current ? (
                <button
                  className="ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-color-text ui-border-0 ui-border-radius-8px ui-text-align-left ui-font-inherit ui-background-none appbar-item danger"
                  disabled={props.apps.length < 2}
                  title={props.apps.length < 2 ? "Clay keeps at least one usable app" : undefined}
                  onClick={() => { setOpen(false); props.onDelete(current.id); }}
                >
                  Delete “{current.name}”
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <div className="ui ui-display-flex ui-base-gap-2e0455 appbar-mode" role="group" aria-label="Workspace mode">
        {(["work", "customize"] as const).map(mode => (
          <button key={mode}
            className={`ui ui-align-items-center ui-color-text-2 ui-border-radius-10px ui-display-inline-flex ui-gap-7px ui-background-transparent ui-hover-color-caf367 appbar-action appbar-mode-button${props.workspaceMode === mode ? " active" : ""}`}
            aria-pressed={props.workspaceMode === mode}
            onClick={() => props.onWorkspaceModeChange(mode)}>
            {mode === "work" ? "Work" : "Customize"}
          </button>
        ))}
      </div>

      <button className={`ui ui-align-items-center ui-color-text-2 ui-base-border-f41cca ui-display-inline-flex ui-background-bg-soft ui-gap-7px ui-white-space-nowrap ui-border-radius-999px ui-font-size-11-5px appbar-trust${props.persistent ? "" : " appbar-trust-warn"}`}
        aria-label="Open Recovery Center" onClick={props.onOpenRecovery}>
        <span className="ui ui-border-radius-50 appbar-trust-dot" aria-hidden="true" />
        {props.persistent ? "Saved in this browser's OPFS only" : "Not saved - temporary session"}
        {props.workspaceMode === "customize" ? ` - version ${props.version}` : ""}
      </button>
      <div className="ui ui-position-relative appbar-lens">
        <button
          ref={lensButtonRef}
          className={`ui ui-align-items-center ui-color-text-2 ui-border-radius-10px ui-display-inline-flex ui-gap-7px ui-background-transparent ui-hover-color-caf367 appbar-action appbar-lens-btn${props.lensId === "all" ? "" : " active"}`}
          aria-label={`Choose situational lens. Current: ${currentLens.name}`}
          aria-expanded={lensOpen}
          aria-haspopup="dialog"
          title="Change which views are visible without changing your data"
          onClick={() => { setOpen(false); setThemeOpen(false); setLensOpen(value => !value); }}
        >
          <span className="ui ui-font-size-13px ui-color-accent appbar-action-icon" aria-hidden="true">◉</span>
          <span className="appbar-action-label">{currentLens.name}</span>
        </button>
        {lensOpen ? (
          <ModalDialog className="ui ui-display-flex ui-background-panel ui-flex-direction-column ui-base-border-8f9f0d ui-position-fixed ui-overflow-y-auto ui-gap-3px ui-box-shadow-shadow-lg appbar-lens-menu"
            backdropClassName="ui ui-position-fixed ui-inset-0 appbar-backdrop appbar-lens-backdrop"
            ariaLabel="Situational lenses" onClose={() => closeLens()}
            returnFocusRef={lensButtonRef}>
              <span className="ui ui-color-text-3 ui-text-transform-uppercase appbar-menu-label">Same data, different moment</span>
              {props.lenses.map((lens, index) => (
                <div key={lens.id} className="ui ui-display-flex ui-align-items-center ui-gap-3px appbar-lens-row">
                  <FocusButton
                    ref={element => {
                      if (element) lensItemRefs.current.set(lens.id, element);
                      else lensItemRefs.current.delete(lens.id);
                      if (index === 0) firstLensRef.current = element;
                    }}
                    aria-pressed={lens.id === props.lensId}
                    disabled={lens.id !== "all" && lens.panelIds.length === 0}
                    autoFocus={index === 0}
                    className={`ui ui-display-flex ui-align-items-center ui-justify-content-space-between ui-color-text ui-min-width-0 ui-border-radius-10px ui-gap-12px ui-border-0 ui-text-align-left ui-font-inherit ui-background-transparent ui-flex-1 appbar-lens-item${lens.id === props.lensId ? " selected" : ""}`}
                    onClick={() => selectLens(lens.id)}>
                    <span><b>{lens.name}</b><small>{lens.description}</small></span>
                    <em>{lens.capturedCount === undefined
                      ? lens.panelIds.length : `${lens.panelIds.length}/${lens.capturedCount}`}</em>
                  </FocusButton>
                  {props.workspaceMode === "customize" && isSavedLensId(lens.id) ? (
                    confirmDeleteLens === lens.id ? (
                      <div className="ui ui-display-flex ui-align-items-center ui-gap-4px appbar-lens-delete-confirm" role="group"
                        aria-label={`Confirm delete lens ${lens.name}`}
                        onKeyDown={event => {
                          if (event.key !== "Escape") return;
                          event.preventDefault(); event.stopPropagation();
                          setConfirmDeleteLens(null);
                          lensItemRefs.current.get(lens.id)?.focus();
                        }}>
                        <FocusButton autoFocus className="danger" onClick={() => void deleteLens(lens.id)}>Delete</FocusButton>
                        <button onClick={() => {
                          setConfirmDeleteLens(null);
                          lensItemRefs.current.get(lens.id)?.focus();
                        }}>Cancel</button>
                      </div>
                    ) : (
                      <button className="ui ui-color-text-3 ui-border-0 ui-border-radius-9px ui-background-transparent appbar-lens-delete"
                        aria-label={`Delete lens ${lens.name}`}
                        onClick={() => setConfirmDeleteLens(lens.id)}>×</button>
                    )
                  ) : null}
                </div>
              ))}
              {props.workspaceMode === "customize" ? (savingLens ? (
                <div className="ui ui-display-flex ui-gap-6px ui-input-font-648ad9 ui-input-border-58fb43 ui-input-border-radius-9af632 ui-input-min-width-39910f appbar-lens-save">
                  <FocusInput autoFocus value={lensDraft} maxLength={40}
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
                <button className="ui ui-color-accent-text ui-text-align-left ui-border-radius-9px ui-background-transparent ui-base-border-9a0e96 appbar-lens-create" disabled={!props.lensReady}
                  title={props.lensReady ? undefined : "Saved lenses are still loading"}
                  onClick={() => setSavingLens(true)}>
                  + Save current view
                </button>
              )) : null}
          </ModalDialog>
        ) : null}
      </div>
      <button
        className="ui ui-align-items-center ui-color-text-2 ui-border-radius-10px ui-display-inline-flex ui-gap-7px ui-background-transparent ui-hover-color-caf367 appbar-action appbar-intake-btn"
        aria-label="Open public intake"
        title="Publish secure forms and review encrypted submissions"
        onClick={props.onOpenIntake}
      >
        <span className="ui ui-font-size-13px ui-color-accent appbar-action-icon" aria-hidden="true">⇣</span>
        <span className="appbar-action-label">Intake</span>
      </button>
      <button
        className="ui ui-align-items-center ui-color-text-2 ui-border-radius-10px ui-display-inline-flex ui-gap-7px ui-background-transparent ui-hover-color-caf367 appbar-action appbar-search-btn"
        aria-label="Search and act"
        title="Find any record or run a quick action (Ctrl+K)"
        onClick={props.onOpenSearch}
      >
        <span className="ui ui-font-size-13px ui-color-accent appbar-action-icon" aria-hidden="true">⌕</span>
        <span className="appbar-action-label">Search</span>
        <kbd className="ui ui-color-text-3 ui-base-border-f41cca ui-font-inherit ui-background-bg appbar-shortcut">Ctrl K</kbd>
      </button>
      {props.workspaceMode === "customize" ? <>
      <button
        className="ui ui-align-items-center ui-color-text-2 ui-border-radius-10px ui-display-inline-flex ui-gap-7px ui-background-transparent ui-hover-color-caf367 appbar-action appbar-automation-btn"
        aria-label="Open automations"
        title="Build rules, reminders, and repeatable actions"
        onClick={props.onOpenAutomations}
      >
        <span className="ui ui-font-size-13px ui-color-accent appbar-action-icon" aria-hidden="true">↻</span>
        <span className="appbar-action-label">Automate</span>
        {props.unreadNotifications > 0 ? (
          <span className="ui ui-display-grid ui-place-items-center ui-border-radius-999px appbar-notification-count" aria-label={`${props.unreadNotifications} unread reminders`}>
            {Math.min(99, props.unreadNotifications)}
          </span>
        ) : null}
      </button>
      <button
        className="ui ui-align-items-center ui-color-text-2 ui-border-radius-10px ui-display-inline-flex ui-gap-7px ui-background-transparent ui-hover-color-caf367 appbar-action appbar-data-btn"
        aria-label="Open all data"
        title="See, edit, and import your data"
        onClick={props.onOpenData}
      >
        <span className="ui ui-font-size-13px ui-color-accent appbar-action-icon" aria-hidden="true">▦</span>
        <span className="appbar-action-label">All data</span>
      </button>
      <button
        className="ui ui-align-items-center ui-color-text-2 ui-border-radius-10px ui-display-inline-flex ui-gap-7px ui-background-transparent ui-hover-color-caf367 appbar-action appbar-shape-btn"
        aria-label="Open data shape"
        title="See how your data, views, and recent changes connect"
        onClick={props.onOpenShapeMap}
      >
        <span className="ui ui-font-size-13px ui-color-accent appbar-action-icon" aria-hidden="true">⌘</span>
        <span className="appbar-action-label">Data shape</span>
      </button>
      <div className="ui ui-position-relative appbar-theme">
        <button
          className="ui ui-display-flex ui-align-items-center ui-background-panel ui-color-text ui-base-border-8f9f0d ui-font-inherit ui-gap-7px appbar-theme-btn"
          aria-label="Choose color scheme"
          title="Color scheme"
          onClick={() => setThemeOpen(o => !o)}
        >
          <span className="ui ui-border-radius-50 appbar-theme-dot" style={{ background: currentTheme.vars.accent }} />
          <span className="appbar-action-label">Theme</span>
        </button>
        {themeOpen ? (
          <>
            <div className="ui ui-position-fixed ui-inset-0 appbar-backdrop" onClick={() => setThemeOpen(false)} />
            <div className="ui ui-display-grid ui-background-panel ui-base-border-8f9f0d ui-gap-7px ui-base-border-radius-25b77c ui-box-shadow-shadow-lg ui-position-absolute appbar-theme-menu">
              {props.themes.map(t => (
                <button
                  key={t.id}
                  className={`ui ui-display-flex ui-align-items-center ui-color-text ui-base-border-8f9f0d ui-border-radius-10px ui-font-inherit ui-gap-7px theme-swatch${t.id === props.themeId ? " selected" : ""}`}
                  title={t.name}
                  onClick={() => { props.onSelectTheme(t.id); setThemeOpen(false); }}
                  style={{ background: t.vars.bg, color: t.vars.text, borderColor: t.vars.borderStrong }}
                >
                  <span className="ui ui-flex-none ui-border-radius-50 theme-dot" style={{ background: t.vars.accent }} />
                  <span className="ui ui-overflow-hidden ui-white-space-nowrap ui-text-overflow-ellipsis theme-name">{t.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <button
        className={`ui ui-display-grid ui-background-panel ui-color-text-3 ui-base-border-8f9f0d ui-border-radius-10px ui-place-items-center appbar-rail-toggle${props.railOpen ? " active" : ""}`}
        aria-label={props.railOpen ? "Close Ask Clay" : "Open Ask Clay"}
        title={props.railOpen ? "Close Ask Clay" : "Open Ask Clay"}
        onClick={props.onToggleRail}
      >
        <span aria-hidden="true">{props.railOpen ? "◧" : "◨"}</span>
      </button>
      </> : null}
    </header>
  );
}
