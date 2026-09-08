import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { PublicIntakePage } from "./intake/PublicIntakeForm";
import { ShareView } from "./share/ShareView";
import { isRecipientSharePathV1 } from "./share/route";
import "./app/styles.css";

const publicIntake = typeof location !== "undefined"
  && location.pathname.replace(/\/+$/u, "") === "/intake";
const entry = isRecipientSharePathV1(window.location.pathname)
  ? <ShareView />
  : publicIntake ? <PublicIntakePage /> : <App />;
createRoot(document.getElementById("root")!).render(entry);
