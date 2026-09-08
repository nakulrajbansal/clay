import type { DbDriver } from "./db";

export const LEGACY_CREDENTIAL_SETTING_KEYS = [
  "byo_api_key",
  "anthropic_api_key",
  "openai_api_key",
  "api_key",
  "clay_session",
  "backend_url",
  "clay_backend_url",
] as const;

const LEGACY_CREDENTIAL_SETTINGS = new Set<string>(LEGACY_CREDENTIAL_SETTING_KEYS);

export function isLegacyCredentialSettingKey(value: unknown): value is string {
  return typeof value === "string" && LEGACY_CREDENTIAL_SETTINGS.has(value);
}

const LEGACY_CREDENTIAL_DELETE_SQL = `DELETE FROM sys.settings WHERE key IN (${
  LEGACY_CREDENTIAL_SETTING_KEYS.map(() => "?").join(",")
})`;

/** Source-private boot upgrade. It deletes keys without reading secret values. */
export function removeLegacyCredentialSettingsForAuthorityBoot(driver: DbDriver): void {
  driver.exec(LEGACY_CREDENTIAL_DELETE_SQL, [...LEGACY_CREDENTIAL_SETTING_KEYS]);
}
