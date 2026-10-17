import { createHash } from "node:crypto";
import { Direction, MessageSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { analyserExport, type MessageImporte } from "./export-whatsapp";

export class ImportRefuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefuseError";
  }
}

export type Apercu = {
  auteurs: string[];
  messages: number;
  ignorees: number;
  ordreDeduit: boolean;
  du: string | null;
  au: string | null;
};

export type ResultatImport = {
  inseres: number;
  deja: number;
  ignorees: number;
  du: string | null;
  au: string | null;
};

// Postgres accepte des insertions bien plus grosses, mais une requête de
// plusieurs dizaines de milliers de lignes garde la transaction ouverte
// longtemps : un export de plusieurs années passe par tranches.
const TRANCHE = 500;

/**
 * Un identifiant stable, dérivé du contenu plutôt que tiré au hasard.
 *
 * C'est ce qui rend un import rejouable : réimporter le même export — le geste
 * le plus naturel quand on doute que ça ait marché — ne duplique rien, parce
 * que les mêmes messages produisent les mêmes identifiants et que l'unicité de
 * `waMessageId` les écarte. Un identifiant aléatoire aurait doublé la
 * conversation à chaque essai.
 */
function identifiant(contactId: string, message: MessageImporte): string {
  const empreinte = createHash("sha1")
    .update(`${message.horodatage.toISOString()}|${message.auteur}|${message.texte}`)
    .digest("base64url")
    .slice(0, 22);
  return `import:${contactId}:${empreinte}`;
}

function bornes(messages: MessageImporte[]): { du: string | null; au: string | null } {
  if (messages.length === 0) return { du: null, au: null };
  const horodatages = messages.map((message) => message.horodatage.getTime());
  return {
    du: new Date(Math.min(...horodatages)).toISOString(),
    au: new Date(Math.max(...horodatages)).toISOString(),
  };
}

/**
 * Ce que le fichier contient, sans rien écrire.
 *
 * L'aperçu existe pour une seule raison : il faut savoir lequel des deux
 * auteurs est le contact avant d'importer. Se tromper inverserait toute la
 * conversation — le rédacteur lirait ses propres messages comme ceux du
 * contact, et l'imiterait lui-même.
 */
export function apercu(contenu: string): Apercu {
  const analyse = analyserExport(contenu);
  return {
    auteurs: analyse.auteurs,
    messages: analyse.messages.length,
    ignorees: analyse.ignorees,
    ordreDeduit: analyse.ordreDeduit,
    ...bornes(analyse.messages),
  };
}

/**
 * Importe une conversation exportée dans le fil d'un contact.
 *
 * Les messages importés n'entrent **jamais** dans le pipeline : aucune
 * décision, aucune escalade, aucun envoi. Classer un historique vieux de deux
 * ans produirait des escalades sur des conversations closes, et pourrait faire
 * répondre à un message d'il y a six mois — le genre de dégât qu'on ne rattrape
 * pas. L'historique sert de contexte au rédacteur, rien d'autre.
 */
export async function importerConversation(params: {
  contactId: string;
  contenu: string;
  /** Lequel des auteurs du fichier est le contact ; le reste est l'utilisateur. */
  auteurContact: string;
}): Promise<ResultatImport> {
  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    include: { thread: true },
  });
  if (!contact) throw new ImportRefuseError("Contact introuvable.");

  const analyse = analyserExport(params.contenu);
  if (analyse.messages.length === 0) {
    throw new ImportRefuseError(
      "Aucun message reconnu dans ce fichier. Exporte la discussion depuis WhatsApp, sans les médias.",
    );
  }
  if (!analyse.auteurs.includes(params.auteurContact)) {
    // Le choix vient d'un aperçu du même fichier : s'il ne correspond plus,
    // c'est que le fichier a changé entre-temps. Importer quand même mettrait
    // tous les messages du mauvais côté.
    throw new ImportRefuseError(
      `« ${params.auteurContact} » n'apparaît pas dans ce fichier. Reprends l'aperçu.`,
    );
  }

  const fil =
    contact.thread ?? (await prisma.thread.create({ data: { contactId: contact.id } }));

  const lignes = analyse.messages.map((message) => ({
    threadId: fil.id,
    waMessageId: identifiant(contact.id, message),
    direction: message.auteur === params.auteurContact ? Direction.IN : Direction.OUT,
    source: MessageSource.IMPORT,
    text: message.texte === "" ? null : message.texte,
    mediaType: message.mediaType,
    timestamp: message.horodatage,
  }));

  let inseres = 0;
  for (let debut = 0; debut < lignes.length; debut += TRANCHE) {
    const { count } = await prisma.message.createMany({
      data: lignes.slice(debut, debut + TRANCHE),
      // Un export recouvre forcément ce que les webhooks ont déjà reçu, et un
      // réimport est un geste normal : les doublons sont attendus, pas une
      // erreur.
      skipDuplicates: true,
    });
    inseres += count;
  }

  const limites = bornes(analyse.messages);
  // Le dernier message du fil ne doit jamais reculer : un import d'archive est
  // plus ancien que la conversation en cours, et écraser cette date ferait
  // paraître le contact silencieux depuis des mois — ce que lit la relance.
  const dernierImporte = new Date(limites.au!);
  if (!fil.lastMessageAt || fil.lastMessageAt < dernierImporte) {
    await prisma.thread.update({
      where: { id: fil.id },
      data: { lastMessageAt: dernierImporte },
    });
  }

  log.info("Historique importé", {
    contactId: contact.id,
    inseres,
    doublons: analyse.messages.length - inseres,
    ignorees: analyse.ignorees,
  });

  return {
    inseres,
    deja: analyse.messages.length - inseres,
    ignorees: analyse.ignorees,
    ...limites,
  };
}
