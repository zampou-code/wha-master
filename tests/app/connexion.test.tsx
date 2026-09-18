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

const fetchMock = vi.fn();

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// La route QR ne renvoie plus de JSON : elle relaie les octets de l'image et
// annonce la durée de validité en en-tête. Le simulacre doit refléter ce
// contrat, sinon les tests passent sans exercer ce que fait vraiment la page.
function reponseImageQr(dureeSec = 30): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { "Content-Type": "image/png", "X-QR-Duration": String(dureeSec) },
  });
}

describe("page d'appairage WhatsApp (/connexion)", () => {
  beforeEach(() => {
    push.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // jsdom n'implémente pas les URL d'objet ; sans ces stubs, la page lèverait
    // au moment d'afficher l'image et l'échec se manifesterait en rejet non géré.
    vi.stubGlobal("URL", Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => "blob:qr"),
      revokeObjectURL: vi.fn(),
    }));
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
        return Promise.resolve(reponseImageQr(30));
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

  it("signale l'expiration sans redemander automatiquement un QR", async () => {
    // Régression vécue en production : la régénération automatique du QR
    // consommait une tentative d'association WhatsApp toutes les ~30 s, ce qui
    // a déclenché la limitation anti-abus (« Impossible de connecter de
    // nouveaux appareils pour le moment ») et a maintenu le compte bloqué.
    // L'expiration doit donc s'afficher et s'arrêter là : la régénération est
    // un geste explicite de l'opérateur, qui est devant l'écran.
    vi.useFakeTimers();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        return Promise.resolve(reponseImageQr(30));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    const avant = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/whatsapp/qr"));
    expect(avant).toHaveLength(1);

    // Bien au-delà de l'expiration (30 s), pour prouver qu'aucune boucle ne
    // repart : ni à l'expiration, ni aux cycles de sondage suivants.
    await vi.advanceTimersByTimeAsync(90_000);

    const apres = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/whatsapp/qr"));
    expect(apres).toHaveLength(1);
    expect(screen.getByText(/Code expiré/)).toBeTruthy();
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
          return Promise.resolve(reponseImageQr(30));
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
