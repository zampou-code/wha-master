import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import { apercu, importerConversation, ImportRefuseError } from "@/import/service";
import { lireContact } from "@/contacts/service";

export const dynamic = "force-dynamic";

// Un export d'un an tient dans quelques centaines de kilo-octets ; huit
// mégaoctets laissent de la marge pour plusieurs années de conversation tout en
// refusant un fichier manifestement hors sujet avant de l'analyser.
const TAILLE_MAX = 8_000_000;

const schema = z.object({
  contenu: z.string().min(1).max(TAILLE_MAX),
  // Absent : on ne rend qu'un aperçu. Présent : on importe. L'aperçu est ce qui
  // permet de choisir lequel des deux auteurs est le contact, et se tromper
  // inverserait toute la conversation.
  auteurContact: z.string().min(1).optional(),
});

export async function POST(request: Request, contexte: { params: Promise<{ id: string }> }) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  const { id } = await contexte.params;
  const analyse = schema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    const trop = analyse.error.issues.some((probleme) => probleme.code === "too_big");
    return NextResponse.json(
      {
        erreur: trop
          ? "Ce fichier dépasse 8 Mo. Exporte la discussion sans les médias."
          : "Fichier illisible.",
      },
      { status: 400 },
    );
  }

  const { contenu, auteurContact } = analyse.data;

  if (auteurContact === undefined) {
    // L'aperçu n'écrit rien : il sert à montrer ce que le fichier contient et à
    // faire choisir l'auteur avant la moindre insertion.
    return NextResponse.json({ apercu: apercu(contenu) });
  }

  try {
    const resultat = await importerConversation({ contactId: id, contenu, auteurContact });
    const contact = await lireContact(id);
    return NextResponse.json({ resultat, contact });
  } catch (erreur) {
    if (erreur instanceof ImportRefuseError) {
      return NextResponse.json({ erreur: erreur.message }, { status: 400 });
    }
    log.error("Import d'historique impossible", {
      contactId: id,
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Import impossible" }, { status: 500 });
  }
}
