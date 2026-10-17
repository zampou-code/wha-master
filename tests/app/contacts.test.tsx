// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
const routerStub = { push };
vi.mock("next/navigation", () => ({ useRouter: () => routerStub }));

const fetchMock = vi.fn();

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SARAH = {
  id: "c1",
  nom: "Sarah",
  jid: "22500000001@s.whatsapp.net",
  mode: "DRAFT" as const,
  isAdult: false,
  messages: 3,
  escaladesOuvertes: 0,
  dernierMessageA: null,
};

function liste(nonPersonnes: { contacts: number; messages: number; decisions: number }) {
  return { contacts: [SARAH], nonPersonnes };
}

/** Les appels DELETE partis vers l'API. */
function suppressions() {
  return fetchMock.mock.calls.filter((appel) => (appel[1] as RequestInit)?.method === "DELETE");
}

async function monter() {
  const { default: Contacts } = await import("@/app/contacts/page");
  render(<Contacts />);
  await screen.findByText("Sarah");
}

describe("page contacts — reste de l'ingestion d'avant", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ne propose rien quand la base est propre", async () => {
    // Un bouton d'effacement qui reste affiché sans rien à effacer est le genre
    // de bouton qu'on finit par appuyer pour voir.
    fetchMock.mockResolvedValue(reponseJson(liste({ contacts: 0, messages: 0, decisions: 0 })));
    await monter();

    expect(screen.queryByRole("button", { name: /Effacer/ })).toBeNull();
  });

  it("n'efface rien au premier appui", async () => {
    // C'est définitif et sans sauvegarde : le premier appui demande à
    // confirmer, et rien ne part avant le second.
    fetchMock.mockResolvedValue(reponseJson(liste({ contacts: 4, messages: 312, decisions: 118 })));
    await monter();

    expect(screen.getByText(/4 groupes ou fils hors conversation/)).toBeTruthy();
    expect(screen.getByText(/312 messages et 118 décisions/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Effacer ces entrées" }));

    expect(suppressions()).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Confirmer l'effacement définitif/ })).toBeTruthy();
  });

  it("efface au second appui et rend compte de ce qui a disparu", async () => {
    fetchMock.mockResolvedValueOnce(
      reponseJson(liste({ contacts: 4, messages: 312, decisions: 118 })),
    );
    await monter();

    await userEvent.click(screen.getByRole("button", { name: "Effacer ces entrées" }));
    fetchMock.mockResolvedValueOnce(
      reponseJson({
        efface: { contacts: 4, messages: 312, decisions: 118 },
        contacts: [SARAH],
        nonPersonnes: { contacts: 0, messages: 0, decisions: 0 },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Confirmer l'effacement définitif/ }));

    expect(suppressions()).toHaveLength(1);
    expect(await screen.findByText(/4 entrées effacées, avec 312 messages et 118 décisions/)).toBeTruthy();
    // La proposition disparaît : il n'y a plus rien à effacer.
    expect(screen.queryByRole("button", { name: /Effacer/ })).toBeNull();
    expect(screen.getByText("Sarah")).toBeTruthy();
  });

  it("dit pourquoi quand l'effacement est refusé", async () => {
    // Croire la base nettoyée alors qu'elle ne l'est pas serait le pire des
    // deux états.
    fetchMock.mockResolvedValueOnce(
      reponseJson(liste({ contacts: 2, messages: 10, decisions: 4 })),
    );
    await monter();

    await userEvent.click(screen.getByRole("button", { name: "Effacer ces entrées" }));
    fetchMock.mockResolvedValueOnce(reponseJson({ erreur: "Effacement impossible" }, 500));
    await userEvent.click(screen.getByRole("button", { name: /Confirmer l'effacement définitif/ }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Effacement impossible");
    expect(screen.getByText(/2 groupes ou fils hors conversation/)).toBeTruthy();
  });
});
