// The multi-app switcher (G4): a header bar to switch between apps, create
// a new one, or delete the current one. Switching is reload-based (App
// handles the reload); this is just the chrome.
import { useState } from "react";
import type { AppEntry } from "./apps";

export function AppSwitcher(props: {
  apps: AppEntry[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onFork: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const current = props.apps.find(a => a.id === props.currentId) ?? null;
  const startRename = (): void => { if (current) { setDraft(current.name); setRenaming(true); } };
  const saveRename = (): void => {
    if (current && draft.trim()) props.onRename(current.id, draft.trim());
    setRenaming(false); setOpen(false);
  };

  return (
    <header className="appbar">
      <span className="appbar-brand">Clay</span>
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
    </header>
  );
}
