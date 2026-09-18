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
    const { qrLink } = await client.getLoginQr(idAppareil);
    const { bytes, contentType } = await client.fetchQrImage(qrLink);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (erreur) {
    console.error("Échec de récupération de l'image QR GOWA :", erreur instanceof Error ? erreur.message : erreur);
    return NextResponse.json({ erreur: "Impossible d'obtenir l'image du QR code" }, { status: 502 });
  }
}
