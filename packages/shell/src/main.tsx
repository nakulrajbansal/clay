import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { PublicIntakePage } from "./intake/PublicIntakeForm";
import "./app/styles.css";

const publicIntake = typeof location !== "undefined"
  && location.pathname.replace(/\/+$/u, "") === "/intake";
createRoot(document.getElementById("root")!).render(publicIntake ? <PublicIntakePage /> : <App />);
