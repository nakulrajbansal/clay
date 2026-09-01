import { describe, expect, it } from "vitest";
import { pruneFeedAfterVersion, type FeedItem } from "../src/app/ConversationRail";

const committed = (version: number): FeedItem => ({
  kind: "committed", summary: `v${version}`, version,
});

describe("pruneFeedAfterVersion", () => {
  it("removes trust receipts for versions truncated by rewind", () => {
    const feed: FeedItem[] = [
      committed(3),
      { kind: "info", text: "ordinary note" },
      committed(4),
      committed(5),
    ];
    expect(pruneFeedAfterVersion(feed, 3)).toEqual([
      committed(3),
      { kind: "info", text: "ordinary note" },
    ]);
  });
});
