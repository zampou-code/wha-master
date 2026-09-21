import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/config/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function creerClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

function instance(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = creerClient();
  }
  return globalForPrisma.prisma;
}

// Instanciation paresseuse. Un `const prisma = creerClient()` au niveau module
// exécutait getEnv() à l'import, ce qui a imposé deux contournements : des
// variables factices dans le Dockerfile pour que `next build` passe, et un
// `await import()` dans la couche IA pour que ses tests unitaires tournent sans
// base. Le proxy préserve exactement l'API — `import { prisma }` puis
// `prisma.contact...` — mais ne construit rien tant qu'aucune propriété n'est lue.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_cible, propriete) {
    // Ni `recepteur` passé à Reflect.get, ni fonction renvoyée telle quelle :
    // dans les deux cas `this` vaudrait le proxy à l'intérieur du client
    // Prisma, dont les accesseurs lisent des champs privés (`#`) qui lèvent
    // sur tout autre objet que l'instance réelle.
    const reel = instance();
    const valeur = Reflect.get(reel, propriete);
    return typeof valeur === "function" ? valeur.bind(reel) : valeur;
  },
  has(_cible, propriete) {
    return Reflect.has(instance(), propriete);
  },
});
