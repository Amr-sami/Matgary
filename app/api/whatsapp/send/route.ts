import { NextResponse } from "next/server";
import { normalizePhone } from "@/lib/settings";

export const runtime = "nodejs";

interface SendBody {
  phone: string;
  message: string;
  instanceId: string;
  token: string;
  apiUrl?: string;
}

export async function POST(req: Request) {
  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { phone, message, instanceId, token, apiUrl } = body;
  if (!phone || !message || !instanceId || !token) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: phone, message, instanceId, token" },
      { status: 400 }
    );
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    return NextResponse.json(
      { ok: false, error: "Invalid phone number" },
      { status: 400 }
    );
  }

  const base = (apiUrl && apiUrl.trim()) || "https://api.green-api.com";
  const url = `${base.replace(/\/$/, "")}/waInstance${encodeURIComponent(
    instanceId
  )}/sendMessage/${encodeURIComponent(token)}`;
  const chatId = `${normalized}@c.us`;

  // Encode body explicitly as UTF-8 bytes so emojis and Arabic don't get
  // turned into "?" by any intermediate layer that defaults to Latin-1.
  const bodyString = JSON.stringify({ chatId, message });
  const bodyBytes = new TextEncoder().encode(bodyString);

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
      },
      body: bodyBytes,
      redirect: "follow",
    });
    const text = await upstream.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Green API normally returns JSON; if not, surface raw text
    }

    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            (json && (json.message || json.error)) ||
            `Green API returned ${upstream.status}`,
          status: upstream.status,
          raw: json ?? text,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      idMessage: json?.idMessage,
      raw: json,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Network error contacting Green API",
      },
      { status: 502 }
    );
  }
}
