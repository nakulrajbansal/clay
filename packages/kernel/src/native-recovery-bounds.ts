// Runtime recovery memory, not frozen bundle budgets or a storage size limit.
// A guarded automation transaction may use at most half the preflight corpus:
// native rollback can restore pages while original journals still exist.
export const NATIVE_SHADOW_BYTES = 64_000_000;
export const NATIVE_AUTOMATION_IO_BYTES = NATIVE_SHADOW_BYTES / 2;
