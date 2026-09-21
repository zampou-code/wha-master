import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import { listerContacts } from "@/contacts/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    return NextResponse.json({ contacts: await listerContacts() });
  } catch (erreur) {
    log.error("Liste des contacts illisible", {
      chemin: "/api/contacts",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Contacts illisibles" }, { status: 500 });
  }
}
