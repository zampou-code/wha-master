import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createGowaClient } from "@/gowa/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    const { code, durationSec } = await createGowaClient().getLoginQr();
    return NextResponse.json({ code, durationSec });
  } catch {
    return NextResponse.json({ erreur: "Impossible d'obtenir le QR code" }, { status: 502 });
  }
}
