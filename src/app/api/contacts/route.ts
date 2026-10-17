import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import { compterNonPersonnes, listerContacts, supprimerNonPersonnes } from "@/contacts/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    // Le reste de l'ingestion d'avant part avec la liste : c'est ce qui décide
    // d'afficher ou non la proposition d'effacement, et ça évite un second
    // aller-retour pour une page qu'on ouvre sur un téléphone.
    const [contacts, nonPersonnes] = await Promise.all([listerContacts(), compterNonPersonnes()]);
    return NextResponse.json({ contacts, nonPersonnes });
  } catch (erreur) {
    log.error("Liste des contacts illisible", {
      chemin: "/api/contacts",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Contacts illisibles" }, { status: 500 });
  }
}

/**
 * Efface les « contacts » qui n'en sont pas — groupes, statuts, chaînes — avec
 * leurs messages et leurs décisions. Irréversible, et réservé à cette seule
 * cible : aucun identifiant n'est accepté, donc aucune requête ne peut
 * emporter un vrai contact.
 */
export async function DELETE(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    const efface = await supprimerNonPersonnes();
    const [contacts, nonPersonnes] = await Promise.all([listerContacts(), compterNonPersonnes()]);
    return NextResponse.json({ efface, contacts, nonPersonnes });
  } catch (erreur) {
    log.error("Effacement des contacts hors personnes impossible", {
      chemin: "/api/contacts",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Effacement impossible" }, { status: 500 });
  }
}
