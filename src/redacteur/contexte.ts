import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export type FaitPartageable = { id: string; key: string; value: string };

export type ContexteRedaction = {
  styleGuide: Record<string, unknown>;
  hardLimits: string[];
  termesInterdits: string[];
  faits: FaitPartageable[];
  resumeFil: string;
  derniersMessages: { direction: "IN" | "OUT"; texte: string }[];
  stylePolitique: { longueur: string; emoji: string; formalite: string; langue: string };
};

const NOMBRE_DE_MESSAGES = 20;

// Le styleGuide est stocké en JSON par Prisma (Prisma.JsonValue) : à la racine
// on attend un objet, jamais une chaîne, un nombre ou un tableau. Ce garde
// restreint le type au lieu de forcer une conversion sur la valeur brute.
function commeStyleGuide(valeur: Prisma.JsonValue | undefined): Record<string, unknown> {
  if (valeur !== null && typeof valeur === "object" && !Array.isArray(valeur)) {
    return valeur;
  }
  return {};
}

export async function assemblerContexte(contactId: string): Promise<ContexteRedaction> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    include: { policy: true, thread: true },
  });
  if (!contact) throw new Error(`Contact ${contactId} introuvable`);

  const profil = await prisma.personaProfile.findUnique({ where: { id: "self" } });

  // P4 : le filtre est ici, dans la requête. Un fait non partageable n'atteint
  // jamais le modèle — ce n'est pas une consigne de prompt qu'il pourrait
  // ignorer, c'est une donnée qui ne lui est pas transmise.
  const faits = await prisma.personaFact.findMany({
    where: { shareable: true },
    select: { id: true, key: true, value: true },
    orderBy: { key: "asc" },
  });

  const messages = contact.thread
    ? await prisma.message.findMany({
        where: { threadId: contact.thread.id },
        // `id` départage les égalités d'horodatage : WhatsApp peut livrer
        // plusieurs messages à la même seconde, et sans deuxième clé l'ordre
        // entre eux n'est garanti par aucune norme SQL — il dépend du plan
        // d'exécution. Sans ce départage, un IN et un OUT peuvent s'inverser
        // et le rédacteur lit la conversation à contretemps.
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: NOMBRE_DE_MESSAGES,
        select: { direction: true, text: true },
      })
    : [];

  return {
    styleGuide: commeStyleGuide(profil?.styleGuide),
    hardLimits: profil?.hardLimits ?? [],
    termesInterdits: profil?.termesInterdits ?? [],
    faits,
    resumeFil: contact.thread?.rollingSummary ?? "",
    derniersMessages: messages
      .reverse()
      .map((m) => ({ direction: m.direction, texte: m.text ?? "" })),
    stylePolitique: {
      longueur: contact.policy?.styleLength ?? "moyen",
      emoji: contact.policy?.styleEmoji ?? "parfois",
      formalite: contact.policy?.styleFormality ?? "tutoiement",
      langue: contact.policy?.styleLanguage ?? "fr",
    },
  };
}
