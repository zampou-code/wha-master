import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/config/env";
import { log } from "@/lib/log";

export async function seedAdmin(): Promise<void> {
  const env = getEnv();
  const ctx = await auth.$context;
  const existant = await prisma.user.findUnique({ where: { email: env.ADMIN_EMAIL } });

  if (existant) {
    const compteCredential = await ctx.internalAdapter.findCredentialAccount(existant.id);
    if (compteCredential) {
      log.info("Compte déjà présent, rien à faire", { email: env.ADMIN_EMAIL });
      return;
    }

    // L'utilisateur existe mais le compte credential associé n'a jamais été
    // créé (arrêt du conteneur entre les deux écritures) : on répare plutôt
    // que de laisser l'opérateur sans moyen de se connecter.
    const hashReparation = await ctx.password.hash(env.ADMIN_PASSWORD);
    await ctx.internalAdapter.createAccount({
      userId: existant.id,
      providerId: "credential",
      accountId: existant.id,
      password: hashReparation,
    });
    log.info("Compte incomplet (identifiants manquants) : réparé", { email: env.ADMIN_EMAIL });
    return;
  }

  const total = await prisma.user.count();
  if (total > 0) {
    throw new Error(
      "Un compte existe déjà avec une autre adresse. Cette application est mono-utilisateur.",
    );
  }

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
  log.info("Compte créé", { email: env.ADMIN_EMAIL });
}

if (process.argv[1]?.endsWith("seed-admin.ts")) {
  seedAdmin()
    .then(() => process.exit(0))
    .catch((erreur) => {
      log.error("Échec du seed du compte administrateur", {
        erreur: erreur instanceof Error ? erreur : String(erreur),
      });
      process.exit(1);
    });
}
