import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createGowaClient } from "@/gowa/client";
import { log } from "@/lib/log";
import { lireGroupeDeControle, enregistrerGroupeDeControle } from "@/controle/groupe";
import { MARQUEUR_FAIT } from "@/controle/marqueurs";

export const dynamic = "force-dynamic";

const choixSchema = z.object({
  jid: z.string().min(1, "Choisis un groupe."),
});

async function refuserSansSession(request: Request): Promise<NextResponse | null> {
  try {
    await requireSession(request.headers);
    return null;
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }
}

export async function GET(request: Request) {
  const refus = await refuserSansSession(request);
  if (refus) return refus;

  try {
    const groupe = await lireGroupeDeControle();
    return NextResponse.json({ groupe });
  } catch (erreur) {
    log.error("Lecture du groupe de contrôle impossible", {
      chemin: "/api/controle/groupe",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Réglage illisible" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const refus = await refuserSansSession(request);
  if (refus) return refus;

  const analyse = choixSchema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    return NextResponse.json({ erreur: "Choisis un groupe." }, { status: 400 });
  }

  let groupes;
  try {
    const client = createGowaClient();
    groupes = await client.listGroups(await client.ensureDevice());
  } catch (erreur) {
    log.error("Liste des groupes indisponible au moment du choix", {
      chemin: "/api/controle/groupe",
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "WhatsApp injoignable" }, { status: 502 });
  }

  // On n'enregistre que ce que WhatsApp confirme. Un identifiant saisi ou
  // deviné qui ne correspond à aucun groupe rejoint donnerait un réglage
  // d'apparence valide, sur lequel chaque escalade partirait dans le vide.
  const choisi = groupes.find((groupe) => groupe.jid === analyse.data.jid);
  if (!choisi) {
    return NextResponse.json(
      { erreur: "Ce groupe ne fait pas partie de ceux où tu es. Rafraîchis la liste." },
      { status: 400 },
    );
  }
  if (choisi.estCommunaute) {
    return NextResponse.json(
      { erreur: "Une communauté ne reçoit pas de messages. Choisis un groupe ordinaire." },
      { status: 400 },
    );
  }

  // On prouve AVANT d'enregistrer. Un envoi de vérification qui échoue n'est
  // pas un détail cosmétique : c'est la démonstration que les escalades
  // n'arriveront jamais dans ce groupe. Enregistrer quand même laisserait un
  // réglage d'apparence valide sur lequel chaque message à valider disparaîtrait
  // en silence — le cas concret étant un groupe « annonces seulement » où le
  // propriétaire n'est pas administrateur. Tester la capacité réelle vaut mieux
  // que deviner d'après les drapeaux du groupe : un groupe en annonces dont il
  // EST administrateur fonctionne parfaitement, et doit rester utilisable.
  try {
    await createGowaClient().sendText({
      phone: choisi.jid,
      message:
        `${MARQUEUR_FAIT} Groupe de contrôle relié. ` +
        "C'est ici que les messages à valider arriveront.",
    });
  } catch (erreur) {
    log.error("Envoi de vérification impossible, groupe de contrôle non enregistré", {
      jid: choisi.jid,
      annoncesSeulement: choisi.annoncesSeulement,
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json(
      {
        erreur: choisi.annoncesSeulement
          ? "Impossible d'écrire dans ce groupe : il est en « annonces seulement » et tu n'y es pas administrateur. Rien n'a été changé."
          : "Impossible d'écrire dans ce groupe. Rien n'a été changé — réessaie.",
      },
      { status: 502 },
    );
  }

  await enregistrerGroupeDeControle({ jid: choisi.jid, nom: choisi.nom });

  return NextResponse.json({
    groupe: { jid: choisi.jid, nom: choisi.nom, source: "interface" },
  });
}
