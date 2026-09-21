import { prisma } from "@/lib/prisma";

// La liste tenue à la main a été trouvée incomplète trois fois, et l'une de ces
// omissions a laissé des tests d'intégration atteindre un vrai fournisseur d'IA.
// Une liste dérivée du schéma ne peut plus rien oublier : toute table ajoutée
// par une migration future est nettoyée sans que personne y pense.
let cache: string[] | null = null;

export async function tablesATronquer(): Promise<string[]> {
  if (cache) return cache;
  const lignes = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_prisma%'`,
  );
  cache = lignes.map((l) => l.table_name);
  return cache;
}

export async function resetDb(): Promise<void> {
  const tables = await tablesATronquer();
  if (tables.length === 0) return;
  const liste = tables.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${liste} RESTART IDENTITY CASCADE`);
}
