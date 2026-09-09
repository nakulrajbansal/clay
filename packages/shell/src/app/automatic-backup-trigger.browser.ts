import type { BackupRun, BackupTarget } from "@clay/kernel/backup";
import type { AuthorityCommitNotice } from "./worker-client";

export type AutomaticBackupTriggerTarget = Readonly<{
  target: BackupTarget;
  folderName: string;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

export type AutomaticBackupTriggerOptions = Readonly<{
  getTarget(): AutomaticBackupTriggerTarget | null;
  run(target: AutomaticBackupTriggerTarget, reason: BackupRun["reason"]): Promise<boolean>;
  idleDelayMs?: number;
  deadlineMs?: number;
  minimumStartIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}>;

const DEFAULT_IDLE_DELAY_MS = 30_000;
const DEFAULT_DEADLINE_MS = 15 * 60_000;
const DEFAULT_MINIMUM_START_INTERVAL_MS = 5 * 60_000;

function fingerprint(notice: AuthorityCommitNotice): string {
  return [
    notice.appInstanceId,
    notice.activeGenerationId,
    notice.lineageEpoch,
    notice.protectionRevision,
    String(notice.digestSchema),
    notice.stateSha256,
  ].join("\u0000");
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1)
    throw new Error("automatic backup timing configuration is invalid");
  return chosen;
}

/**
 * App-open-only scheduler. Authority commit notices are coalesced by their
 * immutable target tuple, while a separately armed deadline prevents idle or
 * rate limiting from pushing a dirty target beyond fifteen minutes.
 */
export class AutomaticBackupTriggerController {
  readonly #getTarget: AutomaticBackupTriggerOptions["getTarget"];
  readonly #run: AutomaticBackupTriggerOptions["run"];
  readonly #idleDelayMs: number;
  readonly #deadlineMs: number;
  readonly #minimumStartIntervalMs: number;
  readonly #now: () => number;
  readonly #setTimer: NonNullable<AutomaticBackupTriggerOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<AutomaticBackupTriggerOptions["clearTimer"]>;
  #dirty: { fingerprint: string; since: number } | null = null;
  #idleTimer: TimerHandle | null = null;
  #deadlineTimer: TimerHandle | null = null;
  #lastStart: number | null = null;
  #running = false;
  #stopped = false;

  constructor(options: AutomaticBackupTriggerOptions) {
    this.#getTarget = options.getTarget;
    this.#run = options.run;
    this.#idleDelayMs = positiveDuration(options.idleDelayMs, DEFAULT_IDLE_DELAY_MS);
    this.#deadlineMs = positiveDuration(options.deadlineMs, DEFAULT_DEADLINE_MS);
    this.#minimumStartIntervalMs = positiveDuration(
      options.minimumStartIntervalMs,
      DEFAULT_MINIMUM_START_INTERVAL_MS,
    );
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
  }

  notifyAuthorityCommit(notice: AuthorityCommitNotice): void {
    if (this.#stopped) return;
    const target = this.#getTarget();
    if (!target || target.target.appInstanceId !== notice.appInstanceId) return;
    const nextFingerprint = fingerprint(notice);
    if (this.#dirty?.fingerprint === nextFingerprint) return;
    const now = this.#checkedNow();
    this.#dirty = {
      fingerprint: nextFingerprint,
      since: this.#dirty?.since ?? now,
    };
    this.#armIdle();
    this.#armDeadline();
  }

  stop(): void {
    this.#stopped = true;
    this.#dirty = null;
    this.#clearIdle();
    this.#clearDeadline();
  }

  #checkedNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("automatic backup clock is invalid");
    return value;
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) this.#clearTimer(this.#idleTimer);
    this.#idleTimer = null;
  }

  #clearDeadline(): void {
    if (this.#deadlineTimer !== null) this.#clearTimer(this.#deadlineTimer);
    this.#deadlineTimer = null;
  }

  #armIdle(): void {
    this.#clearIdle();
    if (!this.#dirty || this.#stopped) return;
    const now = this.#checkedNow();
    const rateDelay = this.#lastStart === null
      ? 0 : Math.max(0, this.#lastStart + this.#minimumStartIntervalMs - now);
    const delay = Math.max(this.#idleDelayMs, rateDelay);
    this.#idleTimer = this.#setTimer(() => {
      this.#idleTimer = null;
      void this.#start("meaningful_write");
    }, delay);
  }

  #armDeadline(): void {
    if (this.#deadlineTimer !== null || !this.#dirty || this.#stopped) return;
    const now = this.#checkedNow();
    const deadlineAt = this.#dirty.since + this.#deadlineMs;
    const rateAt = this.#lastStart === null ? 0
      : this.#lastStart + this.#minimumStartIntervalMs;
    const delay = Math.max(0, Math.max(deadlineAt, rateAt) - now);
    this.#deadlineTimer = this.#setTimer(() => {
      this.#deadlineTimer = null;
      void this.#start("deadline");
    }, delay);
  }

  async #start(reason: BackupRun["reason"]): Promise<void> {
    if (this.#stopped || !this.#dirty) return;
    // Completion rearms a still-dirty target. Re-arming an already-expired
    // deadline while a run is active would create a zero-delay timer storm.
    if (this.#running) return;
    const target = this.#getTarget();
    if (!target || target.target.appInstanceId !== this.#dirty.fingerprint.split("\u0000", 1)[0]) {
      this.#dirty = null;
      this.#clearDeadline();
      return;
    }
    const attemptedFingerprint = this.#dirty.fingerprint;
    this.#running = true;
    this.#lastStart = this.#checkedNow();
    let completed = false;
    try {
      completed = await this.#run(target, reason);
    } catch {
      completed = false;
    } finally {
      this.#running = false;
    }
    if (this.#stopped) return;
    if (completed && this.#dirty?.fingerprint === attemptedFingerprint) {
      this.#dirty = null;
      this.#clearIdle();
      this.#clearDeadline();
      return;
    }
    if (this.#dirty) {
      this.#armIdle();
      this.#armDeadline();
    }
  }
}
