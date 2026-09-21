import { ContactMode } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

export type ContactListe = {
  id: string;
  jid: string;
  nom: string;
  alias: string | null;
  pushName: string | null;
  mode: ContactMode;
  isAdult: boolean;
  activatedAt: string | null;
  dernierMessageA: string | null;
  messages: number;
  escaladesOuvertes: number;
};

export type ContactDetail = ContactListe & {
  politique: {
    guardEngagement: boolean;
    guardFacts: boolean;
    guardEmotional: boolean;
    guardMoney: boolean;
    guardIntimate: boolean;
    guardThirdParty: boolean;
    intimateOverride: boolean;
    quietHoursStart: number | null;
    quietHoursEnd: number | null;
    timezone: string;
    maxAutoStreak: number;
    minDelaySec: number;
    maxDelaySec: number;
    styleLength: string;
    styleEmoji: string;
    styleFormality: string;
    styleLanguage: string;
    styleInitiative: string;
  };
};

export class ReglageRefuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReglageRefuseError";
  }
}

function nomLisible(contact: { alias: string | null; pushName: string | null; jid: string }): string {
  return contact.alias ?? contact.pushName ?? contact.jid.split("@")[0];
}

export async function listerContacts(): Promise<ContactListe[]> {
  const contacts = await prisma.contact.findMany({
    include: {
      thread: { select: { lastMessageAt: true, _count: { select: { messages: true } } } },
      _count: { select: { decisions: true } },
    },
    // Les contacts actifs d'abord : ce sont ceux dont un réglage a des
    // conséquences immédiates. Puis les plus récents, le reste étant du bruit
    // importé qu'on ne veut pas faire défiler.
    orderBy: [{ mode: "asc" }, { updatedAt: "desc" }],
  });

  // Les escalades ouvertes remontent avec le contact de leur décision, en une
  // requête : il y en a au plus quelques-unes à la fois, l'agrégat serait plus
  // lourd à lire qu'à exécuter.
  const ouvertes = await prisma.escalation.findMany({
    where: { status: "OPEN" },
    select: { decision: { select: { contactId: true } } },
  });
  const parContact = new Map<string, number>();
  for (const escalade of ouvertes) {
    const contactId = escalade.decision.contactId;
    parContact.set(contactId, (parContact.get(contactId) ?? 0) + 1);
  }

  return contacts.map((contact) => ({
    id: contact.id,
    jid: contact.jid,
    nom: nomLisible(contact),
    alias: contact.alias,
    pushName: contact.pushName,
    mode: contact.mode,
    isAdult: contact.isAdult,
    activatedAt: contact.activatedAt?.toISOString() ?? null,
    dernierMessageA: contact.thread?.lastMessageAt?.toISOString() ?? null,
    messages: contact.thread?._count.messages ?? 0,
    escaladesOuvertes: parContact.get(contact.id) ?? 0,
  }));
}

export async function lireContact(id: string): Promise<ContactDetail | null> {
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: {
      policy: true,
      thread: { select: { lastMessageAt: true, _count: { select: { messages: true } } } },
    },
  });
  if (!contact) return null;

  // La politique est créée à l'ingestion du premier message. Un contact sans
  // politique est une anomalie d'import : on la crée plutôt que d'afficher une
  // fiche vide sur laquelle aucun réglage ne tiendrait.
  const politique =
    contact.policy ?? (await prisma.contactPolicy.create({ data: { contactId: contact.id } }));

  const escaladesOuvertes = await prisma.escalation.count({
    where: { status: "OPEN", decision: { contactId: contact.id } },
  });

  return {
    id: contact.id,
    jid: contact.jid,
    nom: nomLisible(contact),
    alias: contact.alias,
    pushName: contact.pushName,
    mode: contact.mode,
    isAdult: contact.isAdult,
    activatedAt: contact.activatedAt?.toISOString() ?? null,
    dernierMessageA: contact.thread?.lastMessageAt?.toISOString() ?? null,
    messages: contact.thread?._count.messages ?? 0,
    escaladesOuvertes,
    politique: {
      guardEngagement: politique.guardEngagement,
      guardFacts: politique.guardFacts,
      guardEmotional: politique.guardEmotional,
      guardMoney: politique.guardMoney,
      guardIntimate: politique.guardIntimate,
      guardThirdParty: politique.guardThirdParty,
      intimateOverride: politique.intimateOverride,
      quietHoursStart: politique.quietHoursStart,
      quietHoursEnd: politique.quietHoursEnd,
      timezone: politique.timezone,
      maxAutoStreak: politique.maxAutoStreak,
      minDelaySec: politique.minDelaySec,
      maxDelaySec: politique.maxDelaySec,
      styleLength: politique.styleLength,
      styleEmoji: politique.styleEmoji,
      styleFormality: politique.styleFormality,
      styleLanguage: politique.styleLanguage,
      styleInitiative: politique.styleInitiative,
    },
  };
}

export type ModificationContact = {
  alias?: string | null;
  isAdult?: boolean;
  mode?: ContactMode;
};

export async function modifierContact(id: string, modification: ModificationContact): Promise<ContactDetail> {
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: { policy: true },
  });
  if (!contact) throw new ReglageRefuseError("Contact introuvable.");

  const isAdultApres = modification.isAdult ?? contact.isAdult;
  const modeApres = modification.mode ?? contact.mode;

  // Le marquage « majeure » ne se retire pas tant que le contenu intime est
  // débloqué : l'ordre des deux réglages ne doit pas ouvrir une fenêtre où
  // l'un autorise ce que l'autre interdit.
  if (!isAdultApres && contact.policy?.intimateOverride) {
    throw new ReglageRefuseError(
      "Ce contact a le contenu intime débloqué. Referme-le d'abord, puis retire le marquage.",
    );
  }

  const activation = contact.mode === ContactMode.OFF && modeApres !== ContactMode.OFF;

  const misAJour = await prisma.contact.update({
    where: { id },
    data: {
      ...(modification.alias !== undefined ? { alias: modification.alias?.trim() || null } : {}),
      ...(modification.isAdult !== undefined ? { isAdult: modification.isAdult } : {}),
      ...(modification.mode !== undefined ? { mode: modification.mode } : {}),
      // Horodate la première activation et la garde : le principe s'appelle
      // « activation explicite par contact », il doit être auditable après coup.
      ...(activation && contact.activatedAt === null ? { activatedAt: new Date() } : {}),
    },
  });

  if (modification.mode !== undefined && modification.mode !== contact.mode) {
    log.info("Mode de contact changé depuis l'interface", {
      contactId: id,
      avant: contact.mode,
      apres: misAJour.mode,
    });
  }

  const detail = await lireContact(id);
  if (!detail) throw new ReglageRefuseError("Contact introuvable.");
  return detail;
}

export type ModificationPolitique = Partial<ContactDetail["politique"]>;

export async function modifierPolitique(
  id: string,
  modification: ModificationPolitique,
): Promise<ContactDetail> {
  const contact = await prisma.contact.findUnique({ where: { id }, include: { policy: true } });
  if (!contact) throw new ReglageRefuseError("Contact introuvable.");

  // Le contenu intime ne se débloque que sur un contact explicitement marqué
  // majeur, et ce contrôle vit ici, pas seulement dans le formulaire : une
  // requête directe ne doit pas pouvoir le contourner.
  if (modification.intimateOverride === true && !contact.isAdult) {
    throw new ReglageRefuseError(
      "Marque d'abord ce contact comme majeur. Le déblocage n'est jamais automatique.",
    );
  }

  const heures = [modification.quietHoursStart, modification.quietHoursEnd];
  for (const heure of heures) {
    if (heure !== undefined && heure !== null && (heure < 0 || heure > 23)) {
      throw new ReglageRefuseError("Les heures de silence vont de 0 à 23.");
    }
  }

  const minimum = modification.minDelaySec ?? contact.policy?.minDelaySec ?? 45;
  const maximum = modification.maxDelaySec ?? contact.policy?.maxDelaySec ?? 600;
  if (minimum > maximum) {
    throw new ReglageRefuseError("Le délai minimum ne peut pas dépasser le maximum.");
  }

  await prisma.contactPolicy.upsert({
    where: { contactId: id },
    create: { contactId: id, ...modification },
    update: modification,
  });

  const detail = await lireContact(id);
  if (!detail) throw new ReglageRefuseError("Contact introuvable.");
  return detail;
}
