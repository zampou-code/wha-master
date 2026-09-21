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
  const groupeDeControle = process.env.CONTROL_GROUP_JID ? "configuré" : "absent";

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "up", groupeDeControle });
  } catch {
    return NextResponse.json({ status: "degraded", db: "down", groupeDeControle }, { status: 503 });
  }
}
