"use client";

export interface SendArgs {
  phone: string;
  message: string;
  instanceId: string;
  token: string;
  apiUrl?: string;
}

export interface SendResult {
  ok: boolean;
  idMessage?: string;
  error?: string;
  status?: number;
}

export async function sendViaGreenApi(args: SendArgs): Promise<SendResult> {
  try {
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = (await res.json()) as SendResult;
    return data;
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error" };
  }
}
