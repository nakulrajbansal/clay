import type { TrustReceipt } from "./change-contract";

export type FeedItem =
  | { kind: "intent"; text: string }
  | { kind: "clarify"; question: string }
  | { kind: "failure"; reasons: string[] }
  | { kind: "committed"; summary: string; version: number; receipt?: TrustReceipt }
  | { kind: "discarded"; summary: string }
  | { kind: "info"; text: string };

export function pruneFeedAfterVersion(feed: FeedItem[], version: number): FeedItem[] {
  return feed.filter(item => item.kind !== "committed" || item.version <= version);
}
