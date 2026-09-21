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

  await enregistrerGroupeDeControle({ jid: choisi.jid, nom: choisi.nom });

  // Message de vérification : il prouve tout de suite que l'envoi fonctionne,
  // plutôt que de le découvrir à la première escalade réelle. Le marqueur le
  // fait ignorer au retour par le webhook, comme toute publication du système.
  let confirmationEnvoyee = true;
  try {
    await createGowaClient().sendText({
      phone: choisi.jid,
      message:
        `${MARQUEUR_FAIT} Groupe de contrôle relié. ` +
        "C'est ici que les messages à valider arriveront.",
    });
  } catch (erreur) {
    // Le réglage reste enregistré : l'envoi peut échouer pour une raison
    // passagère, et le perdre obligerait à tout recommencer.
    confirmationEnvoyee = false;
    log.error("Message de confirmation non posté dans le groupe de contrôle", {
      jid: choisi.jid,
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
  }

  return NextResponse.json({
    groupe: { jid: choisi.jid, nom: choisi.nom, source: "interface" },
    confirmationEnvoyee,
  });
}
