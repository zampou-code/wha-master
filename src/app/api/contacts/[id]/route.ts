import { NextResponse } from "next/server";
import { z } from "zod";
import { ContactMode } from "@/generated/prisma/client";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import {
  lireContact,
  modifierContact,
  modifierPolitique,
  ReglageRefuseError,
} from "@/contacts/service";

export const dynamic = "force-dynamic";

const heure = z.number().int().min(0).max(23).nullable();

const modificationSchema = z.object({
  alias: z.string().nullable().optional(),
  isAdult: z.boolean().optional(),
  mode: z.enum(ContactMode).optional(),
  politique: z
    .object({
      guardEngagement: z.boolean().optional(),
      guardFacts: z.boolean().optional(),
      guardEmotional: z.boolean().optional(),
      guardMoney: z.boolean().optional(),
      guardIntimate: z.boolean().optional(),
      guardThirdParty: z.boolean().optional(),
      intimateOverride: z.boolean().optional(),
      quietHoursStart: heure.optional(),
      quietHoursEnd: heure.optional(),
      timezone: z.string().min(1).optional(),
      maxAutoStreak: z.number().int().min(1).max(50).optional(),
      minDelaySec: z.number().int().min(0).max(86_400).optional(),
      maxDelaySec: z.number().int().min(0).max(86_400).optional(),
      styleLength: z.enum(["court", "moyen", "long"]).optional(),
      styleEmoji: z.enum(["jamais", "parfois", "souvent"]).optional(),
      styleFormality: z.enum(["tutoiement", "vouvoiement"]).optional(),
      styleLanguage: z.string().min(2).max(5).optional(),
      styleInitiative: z.enum(["jamais", "rare", "souvent"]).optional(),
    })
    .optional(),
});

async function sansSession(request: Request): Promise<NextResponse | null> {
  try {
    await requireSession(request.headers);
    return null;
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }
}

export async function GET(request: Request, contexte: { params: Promise<{ id: string }> }) {
  const refus = await sansSession(request);
  if (refus) return refus;

  const { id } = await contexte.params;
  const contact = await lireContact(id);
  if (!contact) return NextResponse.json({ erreur: "Contact introuvable." }, { status: 404 });
  return NextResponse.json({ contact });
}

export async function PATCH(request: Request, contexte: { params: Promise<{ id: string }> }) {
  const refus = await sansSession(request);
  if (refus) return refus;

  const { id } = await contexte.params;
  const analyse = modificationSchema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    return NextResponse.json({ erreur: "Réglage invalide." }, { status: 400 });
  }

  const { politique, ...surContact } = analyse.data;

  try {
    // L'ordre compte : le marquage « majeure » doit être écrit avant qu'une
    // politique ne s'en réclame, sinon débloquer l'intime et marquer le contact
    // dans le même envoi serait refusé à tort.
    let detail = Object.keys(surContact).length > 0 ? await modifierContact(id, surContact) : null;
    if (politique && Object.keys(politique).length > 0) {
      detail = await modifierPolitique(id, politique);
    }
    if (!detail) detail = await lireContact(id);
    if (!detail) return NextResponse.json({ erreur: "Contact introuvable." }, { status: 404 });
    return NextResponse.json({ contact: detail });
  } catch (erreur) {
    if (erreur instanceof ReglageRefuseError) {
      return NextResponse.json({ erreur: erreur.message }, { status: 400 });
    }
    log.error("Modification de contact impossible", {
      contactId: id,
      erreur: erreur instanceof Error ? erreur : String(erreur),
    });
    return NextResponse.json({ erreur: "Modification impossible" }, { status: 500 });
  }
}
