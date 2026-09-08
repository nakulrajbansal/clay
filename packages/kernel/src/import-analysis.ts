import type {
  HeaderCandidate,
  HeaderCandidateReason,
} from "./import-contracts";

const NEUTRAL_NUMBER = /^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const BOOLEAN = /^(?:true|false|yes|no|y|n)$/i;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function dataLike(value: string): boolean {
  const trimmed = value.trim();
  return NEUTRAL_NUMBER.test(trimmed) || ISO_DATE.test(trimmed) || BOOLEAN.test(trimmed);
}

/** Inspect only the bounded ten-row structure sample; never mutates labels. */
export function recommendHeaderCandidate(rows: readonly (readonly string[])[]): HeaderCandidate {
  const sample = rows.slice(0, 10);
  const candidateIndex = sample.findIndex(row => row.some(value => !isBlank(value)));
  if (candidateIndex < 0) {
    return {
      recommendedRow: null,
      confidence: "none",
      reasons: ["no_non_blank_row"],
    };
  }

  const candidate = sample[candidateIndex]!;
  const normalized = candidate.map(value => value.trim().toLowerCase());
  const allPresent = normalized.every(value => value.length > 0);
  const unique = new Set(normalized).size === normalized.length;
  const textual = candidate.every(value => isBlank(value) || (/\p{L}/u.test(value) && !dataLike(value)));
  const following = sample.slice(candidateIndex + 1).filter(row => row.some(value => !isBlank(value)));
  const contrast = following.length > 0 && candidate.some((value, column) =>
    !isBlank(value) && !dataLike(value)
      && following.some(row => row[column] !== undefined && dataLike(row[column]!)));

  const reasons: HeaderCandidateReason[] = ["first_non_blank_row"];
  reasons.push(allPresent ? "all_labels_present" : "contains_blank_label");
  reasons.push(unique ? "labels_unique" : "duplicate_labels");
  reasons.push(textual ? "labels_textual" : "contains_non_text_label");
  reasons.push(following.length === 0
    ? "no_following_data"
    : contrast ? "data_shape_contrast" : "no_data_shape_contrast");

  return {
    recommendedRow: candidateIndex + 1,
    confidence: allPresent && unique && textual && contrast ? "high" : "low",
    reasons,
  };
}
