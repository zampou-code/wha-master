import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createGowaClient } from "@/gowa/client";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Appairage par numéro de téléphone. Comme la route du QR, cet appel OUVRE une
// session d'appairage côté WhatsApp : il ne doit jamais être placé derrière un
// rafraîchissement automatique, seulement derrière un geste explicite.
export async function POST(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  let telephone: unknown;
  try {
    ({ telephone } = (await request.json()) as { telephone?: unknown });
  } catch {
    return NextResponse.json({ erreur: "Requête illisible" }, { status: 400 });
  }

  if (typeof telephone !== "string" || telephone.trim() === "") {
    return NextResponse.json({ erreur: "Indique ton numéro de téléphone" }, { status: 400 });
  }

  try {
    const client = createGowaClient();
    const idAppareil = await client.ensureDevice();
    const code = await client.loginWithCode(telephone, idAppareil);
    return NextResponse.json({ code });
  } catch (erreur) {
    const message = erreur instanceof Error ? erreur.message : String(erreur);
    log.error("Échec de l'appairage par numéro", { chemin: "/api/whatsapp/pair-code", message });
    // Un numéro mal formé est une erreur de saisie, pas une panne : on la
    // distingue pour que l'opérateur sache quoi corriger.
    if (message.includes("Numéro invalide")) {
      return NextResponse.json({ erreur: message }, { status: 400 });
    }
    return NextResponse.json({ erreur: "Impossible d'obtenir un code d'appairage" }, { status: 502 });
  }
}
