import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createGowaClient } from "@/gowa/client";

export const dynamic = "force-dynamic";

// Route unique du QR, et c'est délibéré. Chaque appel à GET /app/login de GOWA
// démarre une NOUVELLE session d'appairage et annule la précédente : GOWA
// journalise alors « QR context canceled while sending QR path ». Deux routes
// appelant chacune /app/login produisaient donc un code déjà invalidé au moment
// où il s'affichait — le scan ne pouvait pas aboutir. La durée de validité
// voyage dans un en-tête de réponse plutôt que dans un second appel.
export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    const client = createGowaClient();
    const idAppareil = await client.ensureDevice();
    const { qrLink, qrDurationSec } = await client.getLoginQr(idAppareil);
    const { bytes, contentType } = await client.fetchQrImage(qrLink);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        // qr_link ne quitte jamais le serveur : seuls les octets et la durée
        // traversent la frontière vers le navigateur.
        "X-QR-Duration": String(qrDurationSec),
      },
    });
  } catch (erreur) {
    console.error(
      "Échec de récupération de l'image QR GOWA :",
      erreur instanceof Error ? erreur.message : erreur,
    );
    return NextResponse.json({ erreur: "Impossible d'obtenir le QR code" }, { status: 502 });
  }
}
