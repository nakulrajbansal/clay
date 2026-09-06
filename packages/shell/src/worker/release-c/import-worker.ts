import { handleImportParserWorkerRequest } from "./import-worker-runtime";
import {
  IMPORT_SESSION_IDLE_TIMEOUT_MS,
  ImportParserSessionStore,
} from "./parser-session";

const sessions = new ImportParserSessionStore();
setInterval(() => sessions.expireIdleSessions(), IMPORT_SESSION_IDLE_TIMEOUT_MS);

self.onmessage = (event: MessageEvent<unknown>): void => {
  void handleImportParserWorkerRequest(event.data, sessions).then(response => {
    (self as unknown as Worker).postMessage(response);
  });
};
