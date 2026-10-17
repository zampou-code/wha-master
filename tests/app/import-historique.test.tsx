// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ImportHistorique from "@/app/contacts/[id]/import";

const fetchMock = vi.fn();
const surImport = vi.fn();

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const APERCU = {
  auteurs: ["Sarah", "Ibrahim"],
  messages: 312,
  ignorees: 4,
  ordreDeduit: true,
  du: "2026-03-02T10:00:00.000Z",
  au: "2026-10-01T18:30:00.000Z",
};

function fichier(contenu = "[02/03/2026, 10:00:00] Sarah: coucou") {
  return new File([contenu], "Discussion WhatsApp avec Sarah.txt", { type: "text/plain" });
}

async function deposer(contenu?: string) {
  const entree = screen.getByLabelText(/Fichier exporté/i);
  await userEvent.upload(entree, fichier(contenu));
}

/** Le corps JSON du dernier appel parti vers l'API. */
function dernierAppel(): { contenu?: string; auteurContact?: string } {
  const appel = fetchMock.mock.calls.at(-1)!;
  return JSON.parse(String((appel[1] as RequestInit).body));
}

describe("import de l'historique d'un contact", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    surImport.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("montre ce que contient le fichier avant d'importer quoi que ce soit", async () => {
    fetchMock.mockResolvedValueOnce(reponseJson({ apercu: APERCU }));
    render(<ImportHistorique contactId="c1" surImport={surImport} />);

    await deposer();

    expect(await screen.findByText(/312 messages du 2 mars 2026 au 1 octobre 2026/)).toBeTruthy();
    expect(screen.getByText(/4 lignes ignorées/)).toBeTruthy();
    // L'aperçu n'importe rien : un seul appel, sans auteur.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dernierAppel().auteurContact).toBeUndefined();
  });

  it("fait choisir qui est le contact, et l'envoie avec l'import", async () => {
    // Se tromper d'auteur inverse toute la conversation : le rédacteur lirait
    // les messages de l'utilisateur comme ceux du contact.
    fetchMock.mockResolvedValueOnce(reponseJson({ apercu: APERCU }));
    render(<ImportHistorique contactId="c1" surImport={surImport} />);
    await deposer();
    await screen.findByText(/312 messages/);

    await userEvent.click(screen.getByRole("radio", { name: "Ibrahim" }));
    fetchMock.mockResolvedValueOnce(
      reponseJson({ resultat: { inseres: 312, deja: 0, ignorees: 4, du: APERCU.du, au: APERCU.au } }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Importer comme conversation avec Ibrahim/ }));

    expect(dernierAppel().auteurContact).toBe("Ibrahim");
    expect(await screen.findByText(/312 messages importés/)).toBeTruthy();
    expect(surImport).toHaveBeenCalledOnce();
  });

  it("prévient quand l'ordre des dates n'a pas pu être déduit", async () => {
    // Un export lu à l'envers décale la conversation de plusieurs mois ; si ça
    // arrive, il faut savoir d'où ça vient.
    fetchMock.mockResolvedValueOnce(reponseJson({ apercu: { ...APERCU, ordreDeduit: false } }));
    render(<ImportHistorique contactId="c1" surImport={surImport} />);

    await deposer();

    expect(await screen.findByText(/lues comme jour\/mois/)).toBeTruthy();
  });

  it("dit pourquoi quand le fichier est refusé", async () => {
    fetchMock.mockResolvedValueOnce(
      reponseJson({ erreur: "Aucun message reconnu dans ce fichier." }, 400),
    );
    render(<ImportHistorique contactId="c1" surImport={surImport} />);

    await deposer("mes notes de courses");

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Aucun message reconnu dans ce fichier.",
    );
    expect(screen.queryByRole("button", { name: /Importer/ })).toBeNull();
  });

  it("n'importe rien tant qu'aucun auteur n'est choisi", async () => {
    fetchMock.mockResolvedValueOnce(reponseJson({ apercu: { ...APERCU, auteurs: [] } }));
    render(<ImportHistorique contactId="c1" surImport={surImport} />);

    await deposer();

    expect(await screen.findByText(/Aucun auteur reconnu/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Importer/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
