// Share the backend-authoritative payroll PDF.
//
// Mirrors apps/mobile/src/inventory-count/share.ts: the server renders the
// PDF (so the numbers are byte-for-byte what `payroll_periods.snapshot`
// stores), the mobile app downloads it with the bearer token, writes to the
// cache dir, then opens the OS share sheet via expo-sharing.
//
// We never claim to have SENT a WhatsApp message — that's an app-specific
// handoff the user performs from the share sheet. The success story here
// is "the OS sheet opened"; what happens next is up to the user.

import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { api, API_BASE_URL } from "@/api/client";
import { getLocale } from "@/i18n";

export class PayrollShareUnavailableError extends Error {
  constructor() {
    super("sharing unavailable");
    this.name = "PayrollShareUnavailableError";
  }
}

export class PayrollShareFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PayrollShareFetchError";
    this.status = status;
  }
}

export interface SharePayrollInput {
  month: string;
  /** Omit for the register (landscape) PDF; include for a single employee's statement. */
  employeeId?: string;
  /** Final filename — comes from `payrollFilename(...)` in @matgary/domain. */
  filename: string;
}

export async function sharePayrollPdf(input: SharePayrollInput): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new PayrollShareUnavailableError();
  }

  const tokens = await api.currentTokens();
  const locale = getLocale();
  const params = new URLSearchParams({ month: input.month, locale });
  if (input.employeeId) params.set("employeeId", input.employeeId);
  const url = `${API_BASE_URL}/api/payroll/pdf?${params.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : undefined,
  });

  if (!res.ok) {
    throw new PayrollShareFetchError(res.status, `pdf fetch failed (${res.status})`);
  }

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const dest = new File(Paths.cache, input.filename);
  if (dest.exists) dest.delete();
  dest.create();
  dest.write(bytes);

  await Sharing.shareAsync(dest.uri, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
    dialogTitle: input.filename,
  });
}
