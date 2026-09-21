import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  // Sans groupe de contrôle, aucune escalade n'est publiée ni même créée : tout
  // message à risque est abandonné dans le journal. C'est l'état par défaut d'un
  // déploiement neuf, et c'est une dégradation fonctionnelle totale — elle doit
  // se voir ici plutôt que de se découvrir sur une conversation réelle.
  // Lu directement dans l'environnement plutôt que par `getEnv()` : cette route
  // doit répondre même quand la configuration est invalide — c'est précisément
  // le cas où on l'interroge — et `getEnv()` lève dans cette situation.
  let groupeDeControle = process.env.CONTROL_GROUP_JID ? "configuré" : "absent";

  try {
    await prisma.$queryRaw`SELECT 1`;
    // Le groupe choisi dans l'interface vit en base et l'emporte sur la
    // variable d'environnement. Lu directement, sans `lireGroupeDeControle()`,
    // qui passe par `getEnv()` et lèverait sur une configuration invalide.
    const etat = await prisma.systemState.findUnique({
      where: { id: "singleton" },
      select: { controlGroupJid: true },
    });
    if (etat?.controlGroupJid) groupeDeControle = "configuré";
    return NextResponse.json({ status: "ok", db: "up", groupeDeControle });
  } catch {
    return NextResponse.json({ status: "degraded", db: "down", groupeDeControle }, { status: 503 });
  }
}
