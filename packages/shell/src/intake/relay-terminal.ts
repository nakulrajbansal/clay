import { IntakeRelayFormRegistrationV1, IntakeRelayTerminalResultV1 } from "@clay/schema/intake";
import { boundedRelayJson } from "../app/bounded-relay-response";
import { relayRequestSha256 } from "../app/relay-request-identity";
import type { IntakeOwnerTransport } from "./client";

export function intakeRegistration(form: Pick<IntakeOwnerTransport, "publicForm" | "ownerToken">): IntakeRelayFormRegistrationV1 {
  return IntakeRelayFormRegistrationV1.parse({ schema: 1, formId: form.publicForm.formId,
    ownerToken: form.ownerToken, submitToken: form.publicForm.delivery.submitToken,
    expiresAt: form.publicForm.delivery.expiresAt, maxCiphertextBytes: 12 * 1024 * 1024 });
}
export async function terminalizeIntakeRelay(form: Pick<IntakeOwnerTransport, "publicForm" | "ownerToken">,
  relayBaseUrl: string, fetchImpl: typeof fetch): Promise<ReturnType<typeof IntakeRelayTerminalResultV1.parse>> {
  const request = intakeRegistration(form); const identity = await relayRequestSha256(request);
  try {
    const response = await fetchImpl(`${relayBaseUrl.replace(/\/$/u, "")}/intake/forms/${request.formId}/terminalize`, {
      method: "POST", credentials: "include", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error();
    const receipt = IntakeRelayTerminalResultV1.parse(await boundedRelayJson(response, 8 * 1024));
    if (receipt.formId !== request.formId || receipt.expiresAt !== request.expiresAt || receipt.requestSha256 !== identity) throw new Error();
    return receipt;
  } catch { throw new Error("Original intake relay terminalization is unconfirmed; original requests and custody were kept"); }
}
