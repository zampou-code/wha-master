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
    const statut = await createGowaClient().getStatus();
    return NextResponse.json(statut);
  } catch {
    return NextResponse.json({ erreur: "WhatsApp injoignable" }, { status: 502 });
  }
}
