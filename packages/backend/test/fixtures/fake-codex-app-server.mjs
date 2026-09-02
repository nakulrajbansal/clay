import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const capture = process.env.CLAY_CODEX_CAPTURE;
const plan = process.env.CLAY_CODEX_PLAN ?? "{}";
const rl = createInterface({ input: process.stdin });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

rl.on("line", line => {
  const message = JSON.parse(line);
  if (capture) appendFileSync(capture, `${line}\n`);
  if (process.env.CLAY_CODEX_EXIT_EARLY && message.method === "initialize") {
    process.exit(0);
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-test" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-test", status: "inProgress" } } });
    if (process.env.CLAY_CODEX_TOOL_REQUEST) {
      send({ id: 99, method: "tool/call", params: { name: "shell" } });
      return;
    }
    send({ method: "item/completed", params: {
      threadId: "thread-test", turnId: "turn-test",
      item: { id: "item-test", type: "agentMessage", text: plan },
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-test", turn: { id: "turn-test", status: "completed", items: [], error: null },
    } });
  }
});
