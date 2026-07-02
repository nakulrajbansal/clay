// Model ids and endpoints live HERE and nowhere else (gap G2, CLAUDE.md).
// Verified against platform.claude.com on 2026-07-02: claude-sonnet-4-6 is
// an active alias (exact string, no date suffix). claude-sonnet-5 exists as
// a successor — switching is a prompt-affecting change and needs an ADR +
// regression gate run, not a quiet edit.
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Repair rounds may escalate to an Opus-class model behind this flag (G2). */
export const REPAIR_MODEL = "claude-opus-4-8";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

/** Decoding parameters (doc 05 §3). */
export const MAX_TOKENS = 6000;
export const TEMPERATURE = 0.2;
