import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/config/env";

export async function seedAdmin(): Promise<void> {
  const env = getEnv();
  const existant = await prisma.user.findUnique({ where: { email: env.ADMIN_EMAIL } });
  if (existant) {
    console.log(`Compte ${env.ADMIN_EMAIL} déjà présent, rien à faire.`);
    return;
  }

  const total = await prisma.user.count();
  if (total > 0) {
    throw new Error(
      "Un compte existe déjà avec une autre adresse. Cette application est mono-utilisateur.",
    );
  }

  const ctx = await auth.$context;
  const hash = await ctx.password.hash(env.ADMIN_PASSWORD);
  const utilisateur = await ctx.internalAdapter.createUser(
    {
      email: env.ADMIN_EMAIL,
      name: "Propriétaire",
      emailVerified: true,
    },
    { method: "email-password" },
  );
  await ctx.internalAdapter.createAccount({
    userId: utilisateur.id,
    providerId: "credential",
    accountId: utilisateur.id,
    password: hash,
  });
  console.log(`Compte ${env.ADMIN_EMAIL} créé.`);
}

if (process.argv[1]?.endsWith("seed-admin.ts")) {
  seedAdmin()
    .then(() => process.exit(0))
    .catch((erreur) => {
      console.error(erreur);
      process.exit(1);
    });
}
