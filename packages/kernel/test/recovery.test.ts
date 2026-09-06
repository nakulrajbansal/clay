import { describe, expect, it, vi } from "vitest";
import {
  parseAuthenticatedFormat5RestoreGrant,
  type AuthenticatedFormat5RestoreGrant,
} from "../src/recovery";

const id = (prefix: string, character: string): string => `${prefix}_${character.repeat(26)}`;
const sha = (character: string): string => `sha256:${character.repeat(64)}`;

const valid = (): AuthenticatedFormat5RestoreGrant => ({
  schema: 1,
  kind: "authenticated_format5_restore_as_new",
  validationId: id("restoreval", "e"),
  archiveFormat: 5,
  checksumAuthenticated: true,
  archiveSha256: sha("8"),
  archiveTarget: {
    appInstanceId: id("app", "a"),
    activeGenerationId: id("gen", "f"),
    lineageEpoch: "4",
    protectionRevision: "11",
    digestSchema: 1,
    stateSha256: sha("9"),
  },
  preservedAppInstanceId: id("app", "a"),
  destinationAppInstanceId: id("app", "z"),
  installMode: "new_app_only",
  validatedAt: "2026-09-05T20:01:04.000Z",
});

describe("authenticated format-5 restore presentation grant parser", () => {
  it("copies one exact grant and rejects legacy, overwrite, extra, and accessor inputs", () => {
    const source = valid();
    const parsed = parseAuthenticatedFormat5RestoreGrant(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed?.archiveTarget).not.toBe(source.archiveTarget);

    expect(parseAuthenticatedFormat5RestoreGrant({ ...source, archiveFormat: 4 })).toBeNull();
    expect(parseAuthenticatedFormat5RestoreGrant({ ...source, checksumAuthenticated: false })).toBeNull();
    expect(parseAuthenticatedFormat5RestoreGrant({
      ...source,
      destinationAppInstanceId: source.preservedAppInstanceId,
    })).toBeNull();
    expect(parseAuthenticatedFormat5RestoreGrant({ ...source, detail: "trusted" })).toBeNull();

    const getter = vi.fn(() => 5);
    const accessor = { ...source } as Record<string, unknown>;
    Object.defineProperty(accessor, "archiveFormat", { enumerable: true, get: getter });
    expect(parseAuthenticatedFormat5RestoreGrant(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});
