import { z } from "zod";
import { appelerStructure } from "@/ia/appel";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { mesurer, type Mesures } from "./mesures";

/**
 * Déduit d'un historique ce qu'on peut en déduire, et le propose sans
 * l'appliquer.
 *
 * C'était la demande d'origine du projet : « suggérer des paramètres selon
 * l'historique ». La table `ContactProfile` existait depuis la phase 1 et
 * personne ne l'écrivait.
 *
 * Deux sources, séparées exprès :
 *
 * - les réglages viennent de mesures (src/profilage/mesures.ts). Chaque
 *   proposition arrive avec son chiffre, et deux analyses du même historique
 *   donnent le même résultat ;
 * - le ton, le rythme ressenti et les sujets viennent d'un modèle, parce qu'ils
 *   ne se comptent pas.
 *
 * Rien n'est appliqué : les propositions attendent dans la fiche contact. P1
 * reste entier — l'analyse ne touche jamais au mode d'un contact, et ne peut
 * donc activer personne.
 */

// Assez pour que les mesures tiennent, assez peu pour qu'un historique importé
// de cinq ans n'envoie pas tout au modèle. Les plus récents d'abord : un style
// vieux de quatre ans ne dit plus comment on se parle aujourd'hui.
const MESSAGES_MESURES = 400;
const MESSAGES_AU_MODELE = 120;

export const ETAPES_RELATION = [
  "naissant",
  "régulier",
  "intime",
  "distendu",
  "inconnu",
] as const;

const sortieSchema = z.object({
  ton: z.string(),
  rythme: z.string(),
  sujets: z.array(z.string()),
  etape: z.enum(ETAPES_RELATION),
});

export type ParametresProposes = Record<string, { valeur: string | number; preuve: string }>;

export type Profil = {
  ton: string | null;
  rythme: string | null;
  sujets: string[];
  propositions: ParametresProposes;
  messagesAnalyses: number;
  analyseA: string | null;
};

export class ProfilageRefuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilageRefuseError";
  }
}

function construireSysteme(): string {
  return `Tu analyses une conversation privée pour décrire comment deux personnes se parlent. Tu ne donnes aucun conseil et tu ne juges pas la relation.

- "ton" : comment l'autre personne s'adresse à l'utilisateur, en une phrase (ex. « taquine, directe, pose beaucoup de questions »).
- "rythme" : le rythme de la conversation en une phrase (ex. « surtout le soir, par rafales de plusieurs messages »).
- "sujets" : au maximum six sujets récurrents, en deux ou trois mots chacun.
- "etape" : ${ETAPES_RELATION.join(" | ")} — « naissant » s'ils se découvrent, « régulier » si l'échange est installé, « intime » s'il est explicitement amoureux ou sexuel, « distendu » si les échanges s'espacent et se refroidissent, « inconnu » si l'historique ne permet pas de trancher.

N'invente rien : ce que l'historique ne montre pas, tu ne le déduis pas. Réponds en français.`;
}

function construireInvite(messages: { direction: string; text: string | null }[]): string {
  const lignes = messages
    .map((message) => `${message.direction === "IN" ? "Elle/il" : "L'utilisateur"} : ${message.text ?? "(média)"}`)
    .join("\n");
  return `Conversation (du plus ancien au plus récent) :\n${lignes}`;
}

function propositions(mesures: Mesures): ParametresProposes {
  const sortie: ParametresProposes = {};
  for (const [cle, proposition] of Object.entries(mesures)) {
    // `medianeReponseSec` et `sortants` sont des mesures brutes, pas des
    // réglages : elles n'ont pas leur place dans ce qui s'applique.
    if (proposition === null || proposition === undefined) continue;
    if (typeof proposition !== "object") continue;
    sortie[cle] = proposition as { valeur: string | number; preuve: string };
  }
  return sortie;
}

export async function profilerContact(params: {
  contactId: string;
  appeler?: typeof appelerStructure;
}): Promise<Profil> {
  const appeler = params.appeler ?? appelerStructure;
  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    include: { thread: true },
  });
  if (!contact) throw new ProfilageRefuseError("Contact introuvable.");
  if (!contact.thread) {
    throw new ProfilageRefuseError("Aucune conversation à analyser pour ce contact.");
  }

  const recents = await prisma.message.findMany({
    where: { threadId: contact.thread.id },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: MESSAGES_MESURES,
    select: { direction: true, text: true, mediaType: true, timestamp: true },
  });
  if (recents.length === 0) {
    throw new ProfilageRefuseError(
      "Ce fil est vide. Importe l'historique de la conversation avant de l'analyser.",
    );
  }
  const messages = [...recents].reverse();

  const mesures = mesurer(
    messages.map((message) => ({
      direction: message.direction as "IN" | "OUT",
      texte: message.text,
      horodatage: message.timestamp,
    })),
  );

  // L'appel au modèle vient après les mesures : si le fournisseur est
  // indisponible, les propositions chiffrées sont tout de même enregistrées.
  // Elles sont la partie utile, et elles ne coûtent rien.
  let qualitatif: z.infer<typeof sortieSchema> | null = null;
  try {
    const reponse = await appeler({
      role: "profile",
      contactId: params.contactId,
      schema: sortieSchema,
      systeme: construireSysteme(),
      invite: construireInvite(messages.slice(-MESSAGES_AU_MODELE)),
    });
    qualitatif = reponse.valeur;
  } catch (erreur) {
    log.error("Analyse qualitative impossible, mesures conservées", {
      contactId: params.contactId,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  const proposes = propositions(mesures);
  const profil = await prisma.contactProfile.upsert({
    where: { contactId: contact.id },
    create: {
      contactId: contact.id,
      observedTone: qualitatif?.ton ?? null,
      observedRhythm: qualitatif?.rythme ?? null,
      topics: qualitatif?.sujets.slice(0, 6) ?? [],
      proposedParams: proposes,
    },
    update: {
      observedTone: qualitatif?.ton ?? null,
      observedRhythm: qualitatif?.rythme ?? null,
      topics: qualitatif?.sujets.slice(0, 6) ?? [],
      proposedParams: proposes,
    },
  });

  // Deux colonnes que le schéma portait depuis la phase 1 sans que rien ne les
  // remplisse. La médiane sert au planificateur d'envoi ; l'étape de la relation
  // au rédacteur.
  await prisma.thread.update({
    where: { id: contact.thread.id },
    data: {
      medianReplyDelaySec: mesures.medianeReponseSec,
      ...(qualitatif ? { relationStage: qualitatif.etape } : {}),
    },
  });

  log.info("Contact profilé", {
    contactId: contact.id,
    messages: messages.length,
    propositions: Object.keys(proposes).length,
    qualitatif: qualitatif !== null,
  });

  return {
    ton: profil.observedTone,
    rythme: profil.observedRhythm,
    sujets: profil.topics,
    propositions: proposes,
    messagesAnalyses: messages.length,
    analyseA: profil.updatedAt.toISOString(),
  };
}

/** Le profil déjà calculé, sans rien recalculer ni appeler. */
export async function lireProfil(contactId: string): Promise<Profil | null> {
  const profil = await prisma.contactProfile.findUnique({ where: { contactId } });
  if (!profil) return null;
  const brut = profil.proposedParams;
  const propositions: ParametresProposes =
    brut !== null && typeof brut === "object" && !Array.isArray(brut)
      ? (brut as ParametresProposes)
      : {};
  return {
    ton: profil.observedTone,
    rythme: profil.observedRhythm,
    sujets: profil.topics,
    propositions,
    messagesAnalyses: 0,
    analyseA: profil.updatedAt.toISOString(),
  };
}
