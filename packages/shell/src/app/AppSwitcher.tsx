// The multi-app switcher (G4): a header bar to switch between apps, create
// a new one, or delete the current one. Switching is reload-based (App
// handles the reload); this is just the chrome. Also hosts a theme
// quick-switch (palette popover) on the right.
import { useRef, useState } from "react";
import type { AppEntry } from "./apps";
import type { Theme } from "./themes";
import type { LensId, SituationalLens } from "./lenses";

export function AppSwitcher(props: {
  apps: AppEntry[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onFork: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
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
  onSelectLens: (id: LensId) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [themeOpen, setThemeOpen] = useState(false);
  const [lensOpen, setLensOpen] = useState(false);
  const lensButtonRef = useRef<HTMLButtonElement>(null);
  const current = props.apps.find(a => a.id === props.currentId) ?? null;
  const currentTheme = props.themes.find(t => t.id === props.themeId) ?? props.themes[0]!;
  const currentLens = props.lenses.find(lens => lens.id === props.lensId) ?? props.lenses[0]!;
  const startRename = (): void => { if (current) { setDraft(current.name); setRenaming(true); } };
  const saveRename = (): void => {
    if (current && draft.trim()) props.onRename(current.id, draft.trim());
    setRenaming(false); setOpen(false);
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

      <span className={`appbar-trust${props.persistent ? "" : " appbar-trust-warn"}`}>
        <span className="appbar-trust-dot" aria-hidden="true" />
        {props.persistent ? "On this device" : "Session only"} · v{props.version}
      </span>
      <div className="appbar-lens">
        <button
          ref={lensButtonRef}
          className={`appbar-action appbar-lens-btn${props.lensId === "all" ? "" : " active"}`}
          aria-label={`Choose situational lens. Current: ${currentLens.name}`}
          aria-expanded={lensOpen}
          aria-haspopup="menu"
          title="Change which views are visible without changing your data"
          onClick={() => { setOpen(false); setThemeOpen(false); setLensOpen(value => !value); }}
        >
          <span className="appbar-action-icon" aria-hidden="true">◉</span>
          <span className="appbar-action-label">{currentLens.name}</span>
        </button>
        {lensOpen ? (
          <>
            <div className="appbar-backdrop" onClick={() => setLensOpen(false)} />
            <div className="appbar-lens-menu" role="menu" aria-label="Situational lenses"
              onKeyDown={event => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setLensOpen(false);
                  lensButtonRef.current?.focus();
                }
              }}>
              <span className="appbar-menu-label">Same data, different moment</span>
              {props.lenses.map((lens, index) => (
                <button
                  key={lens.id}
                  role="menuitemradio"
                  aria-checked={lens.id === props.lensId}
                  disabled={lens.id !== "all" && lens.panelIds.length === 0}
                  autoFocus={index === 0}
                  className={`appbar-lens-item${lens.id === props.lensId ? " selected" : ""}`}
                  onClick={() => { props.onSelectLens(lens.id); setLensOpen(false); }}
                >
                  <span><b>{lens.name}</b><small>{lens.description}</small></span>
                  <em>{lens.panelIds.length}</em>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
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
    </header>
  );
}
