import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ShareView } from "./share/ShareView";
import { isRecipientSharePathV1 } from "./share/route";
import "./app/styles.css";

const entry = isRecipientSharePathV1(window.location.pathname) ? <ShareView /> : <App />;
createRoot(document.getElementById("root")!).render(entry);
