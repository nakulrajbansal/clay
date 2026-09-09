import { describe, expect, it } from "vitest";
import {
  BackupTrustEnrollment,
  decodeRecoveryKitV1,
  encodeRecoveryKitV1,
  generateBackupTrustMaterialV1,
  type BackupTrustMaterialV1,
} from "../src/recovery-kit";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const material = (): BackupTrustMaterialV1 => ({
  keyId: new Uint8Array(16).map((_, index) => 0x10 + index),
  seriesId: new Uint8Array(16).map((_, index) => 0x20 + index),
  backupTrustKey: new Uint8Array(32).map((_, index) => index),
});

const EXPECTED = "CLAY RECOVERY KIT 1\n"
  + "{\"format\":\"clay-recovery-kit\",\"version\":1,"
  + "\"key_id\":\"EBESExQVFhcYGRobHB0eHw\","
  + "\"backup_series_id\":\"ICEiIyQlJicoKSorLC0uLw\","
  + "\"backup_trust_key\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\","
  + "\"checksum\":\"sha256:32e2f0f1cbf0f32bbde02a9fd629ea284a8de9023a83d275912da34323317953\"}";

describe("Recovery Kit version 1", () => {
  it("matches the independently generated canonical vector", () => {
    expect(decoder.decode(encodeRecoveryKitV1(material()))).toBe(EXPECTED);
    expect(decodeRecoveryKitV1(encoder.encode(EXPECTED))).toEqual(material());
  });

  it("returns defensive copies isolated from caller and encoded-byte mutation", () => {
    const source = material();
    const encoded = encodeRecoveryKitV1(source);
    source.backupTrustKey.fill(0xff);
    const decoded = decodeRecoveryKitV1(encoded);
    encoded.fill(0);
    expect(decoded.backupTrustKey).toEqual(new Uint8Array(32).map((_, index) => index));
    decoded.backupTrustKey.fill(0xff);
    expect(decodeRecoveryKitV1(encoder.encode(EXPECTED)).backupTrustKey[0]).toBe(0);
  });

  it("rejects changed, extended, reordered, padded, or trailing kit text", () => {
    const variants = [
      EXPECTED.replace("AAECAw", "BAECAw"),
      EXPECTED.replace("\"version\":1", "\"version\":1,\"extra\":true"),
      EXPECTED.replace(
        "\"format\":\"clay-recovery-kit\",\"version\":1",
        "\"version\":1,\"format\":\"clay-recovery-kit\"",
      ),
      EXPECTED.replace("EBESExQVFhcYGRobHB0eHw", "EBESExQVFhcYGRobHB0eHw=="),
      `${EXPECTED}\n`,
    ];
    for (const variant of variants)
      expect(() => decodeRecoveryKitV1(encoder.encode(variant))).toThrow(/Recovery Kit|canonical|checksum|field/i);
  });

  it("generates all key material from one trusted 64-byte CSPRNG fill", () => {
    let calls = 0;
    const generated = generateBackupTrustMaterialV1(target => {
      calls++;
      expect(target).toHaveLength(64);
      target.forEach((_, index) => { target[index] = index + 1; });
    });
    expect(calls).toBe(1);
    expect(generated.backupTrustKey).toEqual(new Uint8Array(32).map((_, index) => index + 1));
    expect(generated.keyId).toEqual(new Uint8Array(16).map((_, index) => index + 33));
    expect(generated.seriesId).toEqual(new Uint8Array(16).map((_, index) => index + 49));
    expect(() => generateBackupTrustMaterialV1(() => undefined))
      .toThrow(/secure random|entropy/i);
  });

  it("withholds automatic-backup material until exact exported kit read-back", () => {
    const enrollment = new BackupTrustEnrollment(material());
    const kit = enrollment.recoveryKitBytes();
    expect(enrollment.status()).toBe("needs_export");
    expect(() => enrollment.materialForAutomaticBackup()).toThrow(/export|test-import/i);
    enrollment.recordRecoveryKitExported(kit);
    expect(enrollment.status()).toBe("needs_test_import");
    expect(() => enrollment.materialForAutomaticBackup()).toThrow(/test-import/i);

    const wrong = kit.slice();
    wrong[wrong.byteLength - 1] = wrong[wrong.byteLength - 1]! ^ 1;
    expect(() => enrollment.confirmRecoveryKitImport(wrong)).toThrow(/Recovery Kit|checksum/i);
    expect(enrollment.status()).toBe("needs_test_import");

    enrollment.confirmRecoveryKitImport(kit.slice());
    expect(enrollment.status()).toBe("ready");
    const leased = enrollment.materialForAutomaticBackup();
    expect(leased).toEqual(material());
    leased.backupTrustKey.fill(0xff);
    expect(enrollment.materialForAutomaticBackup().backupTrustKey[0]).toBe(0);

    enrollment.destroy();
    expect(enrollment.status()).toBe("destroyed");
    expect(() => enrollment.materialForAutomaticBackup()).toThrow(/destroyed/i);
  });
});
