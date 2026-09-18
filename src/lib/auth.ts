import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "./prisma";
import { getEnv } from "@/config/env";

const env = getEnv();

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      secure: env.BETTER_AUTH_URL.startsWith("https://"),
      sameSite: "lax",
    },
  },
  rateLimit: { enabled: true, window: 60, max: 10 },
  plugins: [twoFactor(), nextCookies()],
});

export async function requireSession(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Session absente");
  return session;
}
