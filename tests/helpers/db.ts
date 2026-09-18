import { prisma } from "@/lib/prisma";

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Message", "Thread", "ContactPolicy", "ContactProfile", "Decision", "Escalation", "Contact" RESTART IDENTITY CASCADE',
  );
}
