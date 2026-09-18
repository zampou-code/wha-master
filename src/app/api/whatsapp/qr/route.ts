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
    const client = createGowaClient();
    const idAppareil = await client.ensureDevice();
    const { qrDurationSec } = await client.getLoginQr(idAppareil);
    // Ne jamais renvoyer qr_link : c'est une URL vers GOWA, injoignable depuis
    // le navigateur et potentiellement porteuse d'une origine non maîtrisée.
    // Seule une URL relative de même origine, vers la route qui relaie les
    // octets de l'image, quitte cette fonction.
    return NextResponse.json({ durationSec: qrDurationSec, imageUrl: "/api/whatsapp/qr/image" });
  } catch (erreur) {
    console.error("Échec de récupération du QR GOWA :", erreur instanceof Error ? erreur.message : erreur);
    return NextResponse.json({ erreur: "Impossible d'obtenir le QR code" }, { status: 502 });
  }
}
