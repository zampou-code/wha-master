import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { log } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { appelerStructure, AucunFournisseurError } from "@/ia/appel";
import { entreeDepuisConfig } from "@/ia/registre";

export const dynamic = "force-dynamic";

const demandeSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1, "Choisis un modèle à tester."),
});

// Une question minuscule dont la réponse est vérifiable : si le modèle rend
// bien `{ ok: true }`, c'est que la clé, l'adresse, l'identifiant du modèle et
// la sortie structurée fonctionnent tous les quatre.
const sondeSchema = z.object({ ok: z.boolean() });

export async function POST(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  const analyse = demandeSchema.safeParse(await request.json().catch(() => null));
  if (!analyse.success) {
    return NextResponse.json({ erreur: "Choisis un fournisseur et un modèle." }, { status: 400 });
  }

  const config = await prisma.providerConfig.findUnique({ where: { id: analyse.data.providerId } });
  if (!config) {
    return NextResponse.json({ erreur: "Ce fournisseur n'existe plus." }, { status: 404 });
  }

  const entree = entreeDepuisConfig(config, analyse.data.model);
  if (!entree) {
    return NextResponse.json(
      { erreur: "Clé illisible : réenregistre ce fournisseur avec sa clé." },
      { status: 400 },
    );
  }

  const debut = Date.now();
  try {
    await appelerStructure({
      role: "classify",
      schema: sondeSchema,
      systeme: "Réponds uniquement par un objet JSON.",
      invite: 'Renvoie exactement {"ok": true}.',
      entrees: [entree],
    });
    return NextResponse.json({ ok: true, latencyMs: Date.now() - debut });
  } catch (erreur) {
    // Le message du fournisseur est rendu tel quel — déjà expurgé des secrets
    // par la couche d'appel. C'est lui qui dit « modèle inconnu » ou « clé
    // refusée », et c'est précisément ce qu'on cherche à savoir ici.
    const cause =
      erreur instanceof AucunFournisseurError
        ? erreur.derniereErreur
        : erreur instanceof Error
          ? erreur.message
          : String(erreur);
    log.warn("Test de fournisseur en échec", { providerId: config.id, model: analyse.data.model });
    return NextResponse.json({ ok: false, erreur: cause ?? "Échec sans détail." });
  }
}
