// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const MESSAGE_RESEAU = "Connexion réseau impossible. Nouvelle tentative automatique.";

const push = vi.fn();
// Référence stable, comme le vrai useRouter() de Next.js : un mock qui recrée un
// objet à chaque appel ferait changer l'identité de rafraichirStatut/demanderQr
// (useCallback([..., router])) à chaque rendu, et donc re-déclencherait sans fin
// l'effet de sondage (dépendant de rafraichirStatut) — un comportement que le
// vrai hook n'a pas.
const routerStub = { push };
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
}));

const toDataURL = vi.fn().mockResolvedValue("data:image/png;base64,xxx");
vi.mock("qrcode", () => ({
  default: { toDataURL },
}));

const fetchMock = vi.fn();

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("page d'appairage WhatsApp (/connexion)", () => {
  beforeEach(() => {
    push.mockReset();
    toDataURL.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    // L'ordre compte : démonter d'abord (ce qui coupe l'intervalle de sondage
    // via son nettoyage d'effet) pendant que fetch est encore simulé, sinon un
    // cycle en cours peut retomber sur le vrai fetch une fois le stub retiré.
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ne redemande le QR qu'une seule fois pendant plusieurs cycles de sondage à l'état non apparié", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        return Promise.resolve(reponseJson({ code: "2@abc", durationSec: 30 }));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    // Laisse le montage initial se dérouler (premier appel status + premier appel QR).
    await vi.advanceTimersByTimeAsync(0);
    // Simule plusieurs cycles de sondage (3 s chacun) : le statut reste non apparié.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    const appelsStatut = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/whatsapp/status"),
    );
    const appelsQr = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/whatsapp/qr"));

    expect(appelsStatut.length).toBeGreaterThan(1);
    expect(appelsQr).toHaveLength(1);
  });

  it("redirige vers /login sans afficher le message GOWA quand le statut renvoie 401", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ erreur: "Non authentifié" }, 401));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith("/login");
    });

    expect(screen.queryByText("WhatsApp est injoignable.")).toBeNull();
  });

  it("redirige vers /login sans afficher le message GOWA quand le QR renvoie 401", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        return Promise.resolve(reponseJson({ erreur: "Non authentifié" }, 401));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith("/login");
    });

    expect(screen.queryByText("Impossible d'obtenir le QR code.")).toBeNull();
  });

  it("redemande un nouveau QR après expiration (durationSec écoulé)", async () => {
    // Un code d'appairage vit ~20-30s. Sans minuteur de rafraîchissement, un
    // opérateur qui revient après ce délai scanne un code mort sans indice —
    // revue de branche, point 4. Ce test prouve qu'un second appel /qr part
    // automatiquement une fois durationSec écoulé, sans qu'aucune action de
    // l'opérateur ne soit nécessaire.
    vi.useFakeTimers();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        return Promise.resolve(reponseJson({ code: "2@abc", durationSec: 30 }));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    // Comme dans le test de sondage ci-dessus : laisser le montage initial (et
    // un premier cycle de sondage) se dérouler avant de mesurer quoi que ce
    // soit, le temps que les effets React et la chaîne de promesses simulées
    // se propagent complètement.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    const appelsQrAvant = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/whatsapp/qr"));
    expect(appelsQrAvant).toHaveLength(1);

    // Avance jusqu'à l'expiration du code (durationSec = 30s) avec une marge
    // pour la propagation des effets, sans dépasser assez pour déclencher un
    // deuxième cycle d'expiration (qui n'arriverait pas avant 60s).
    await vi.advanceTimersByTimeAsync(30_000);

    const appelsQrApres = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/whatsapp/qr"));
    expect(appelsQrApres.length).toBeGreaterThanOrEqual(2);
  });

  it("affiche un message réseau distinct (et ne redirige pas) quand /status est injoignable", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(MESSAGE_RESEAU);
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("affiche un message réseau distinct quand /qr est injoignable", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(MESSAGE_RESEAU);
    });
  });

  it("le clic sur « Régénérer le code » n'entraîne pas de rejet non intercepté en cas de panne réseau", async () => {
    const utilisateur = userEvent.setup();
    let premierAppelQr = true;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        if (premierAppelQr) {
          premierAppelQr = false;
          return Promise.resolve(reponseJson({ code: "2@abc", durationSec: 30 }));
        }
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.waitFor(() => {
      expect(screen.getByAltText("QR code d'appairage WhatsApp")).toBeTruthy();
    });

    // onClick est un gestionnaire synchrone qui intercepte le rejet de
    // demanderQr() lui-même — même si demanderQr() ne devrait plus rejeter,
    // ceci prouve qu'un clic ne produit jamais de rejet de promesse non géré.
    await utilisateur.click(screen.getByRole("button", { name: /régénérer le code/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(MESSAGE_RESEAU);
    });
  });
});
