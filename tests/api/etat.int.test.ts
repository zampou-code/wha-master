import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContactMode } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { listerContacts } from "@/contacts/service";
import { resetDb } from "../helpers/db";

// Seule la session est simulée : tout le reste de la route lit la vraie base,
// puisque c'est précisément le comptage qu'on vérifie.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireSession: async () => ({ user: { id: "u1" } }),
}));

async function contact(jid: string, mode: ContactMode = ContactMode.OFF) {
  return prisma.contact.create({
    data: { jid, mode, thread: { create: {} }, policy: { create: {} } },
  });
}

describe("GET /api/etat — comptage des contacts", () => {
  beforeEach(resetDb);

  it("compte les mêmes contacts que ceux que la liste montre", async () => {
    // Le tableau de bord annonçait « 47 contacts » quand la page n'en montrait
    // que douze : l'écart venait des groupes, et n'apprenait rien sinon à
    // douter du reste de la page.
    await contact("22500000001@s.whatsapp.net", ContactMode.AUTO);
    await contact("185276188841234@lid");
    await contact("120363401234567890@g.us", ContactMode.AUTO);
    await contact("status@broadcast");

    const { GET } = await import("@/app/api/etat/route");
    const corps = (await (await GET(new Request("http://localhost/api/etat"))).json()) as {
      etat: { contacts: { total: number; actifs: number; pret: boolean } };
    };

    expect(corps.etat.contacts.total).toBe((await listerContacts()).length);
    expect(corps.etat.contacts).toMatchObject({ total: 2, actifs: 1, pret: true });
  });
});
