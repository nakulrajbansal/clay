import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ShareView } from "./share/ShareView";
import { isRecipientSharePathV1 } from "./share/route";
import "./app/primitives.css";
import "./app/styles.css";

const PublicIntakePage = lazy(() => import("./intake/PublicIntakeForm")
  .then(module => ({ default: module.PublicIntakePage })));

const publicIntake = typeof location !== "undefined"
  && location.pathname.replace(/\/+$/u, "") === "/intake";
const entry = isRecipientSharePathV1(window.location.pathname)
  ? <ShareView />
  : publicIntake
    ? <Suspense fallback={<main className="ui ui-base-border-radius-c431a0 ui-label-display-b369c3 ui-label-gap-931d54 public-intake"><p role="status">Opening form…</p></main>}>
        <PublicIntakePage />
      </Suspense>
    : <App />;
createRoot(document.getElementById("root")!).render(entry);
