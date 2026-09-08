// Worker RPC facade. Avoid traversing the broad public barrel when the DB
// worker only needs its MessagePort transport.
export { portFromMessagePort, serveStore } from "./asyncstore";
export type { StoreServerControl } from "./asyncstore";
