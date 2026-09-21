import { getEnv } from "@/config/env";
import { prisma } from "@/lib/prisma";

export type GroupeDeControle = {
  jid: string;
  nom: string | null;
  // D'où vient la valeur : choisie dans l'interface, ou lue dans
  // l'environnement faute de mieux. L'interface l'affiche, pour qu'on sache
  // ce qu'un changement de réglage va remplacer.
  source: "interface" | "environnement";
};

// Point unique de résolution du groupe de contrôle. Avant, quatre endroits
// lisaient CONTROL_GROUP_JID chacun de leur côté ; un réglage fait dans
// l'interface n'aurait été vu que par ceux qu'on aurait pensé à modifier.
// Le réglage en base l'emporte ; la variable d'environnement reste un repli,
// pour ne pas casser un déploiement qui l'avait déjà renseignée.
export async function lireGroupeDeControle(): Promise<GroupeDeControle | null> {
  const etat = await prisma.systemState.findUnique({
    where: { id: "singleton" },
    select: { controlGroupJid: true, controlGroupName: true },
  });
  if (etat?.controlGroupJid) {
    return { jid: etat.controlGroupJid, nom: etat.controlGroupName, source: "interface" };
  }
  const repli = getEnv().CONTROL_GROUP_JID;
  return repli ? { jid: repli, nom: null, source: "environnement" } : null;
}

export async function enregistrerGroupeDeControle(groupe: { jid: string; nom: string }): Promise<void> {
  await prisma.systemState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", controlGroupJid: groupe.jid, controlGroupName: groupe.nom },
    update: { controlGroupJid: groupe.jid, controlGroupName: groupe.nom },
  });
}
