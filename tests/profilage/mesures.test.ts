import { describe, it, expect } from "vitest";
import { mesurer, type MessageMesure } from "@/profilage/mesures";

const DEBUT = new Date("2026-01-01T08:00:00Z").getTime();

/** Un message sortant, `minutes` après l'origine. */
function sortant(texte: string, minutes: number): MessageMesure {
  return { direction: "OUT", texte, horodatage: new Date(DEBUT + minutes * 60_000) };
}

function entrant(texte: string, minutes: number): MessageMesure {
  return { direction: "IN", texte, horodatage: new Date(DEBUT + minutes * 60_000) };
}

/** `nombre` messages sortants identiques, espacés d'une heure. */
function sortants(texte: string, nombre: number): MessageMesure[] {
  return Array.from({ length: nombre }, (_, index) => sortant(texte, index * 60));
}

describe("mesures de l'historique", () => {
  it("ne propose rien sous quinze messages sortants", () => {
    // Trois messages ne font pas un style : proposer un réglage là-dessus
    // donnerait une assurance que la mesure n'a pas.
    const mesures = mesurer([sortant("salut", 0), sortant("ça va ?", 1), entrant("oui", 2)]);

    expect(mesures.styleLength).toBeUndefined();
    expect(mesures.styleEmoji).toBeUndefined();
    expect(mesures.sortants).toBe(2);
  });

  it("déduit la longueur de la médiane, pas de la moyenne", () => {
    // Un seul message très long — une explication, une dispute — décalerait la
    // moyenne et ferait proposer « long » pour une conversation de trois mots.
    const messages = [...sortants("ok", 15), sortant("x".repeat(4000), 100)];

    const mesures = mesurer(messages);

    expect(mesures.styleLength?.valeur).toBe("court");
    expect(mesures.styleLength?.preuve).toMatch(/2 caractères en médiane sur 16 messages/);
  });

  it("classe une conversation bavarde en long", () => {
    const mesures = mesurer(sortants("x".repeat(200), 20));

    expect(mesures.styleLength?.valeur).toBe("long");
  });

  it("compte les emoji de tous les blocs Unicode", () => {
    // Les emoji ne tiennent pas dans une plage unique : visages, symboles et
    // drapeaux vivent dans des blocs séparés, et une regex trop étroite en
    // oublie la moitié.
    const messages = [
      ...sortants("coucou 😍", 4),
      ...Array.from({ length: 2 }, (_, i) => sortant("à toute ✌️", 100 + i * 60)),
      ...Array.from({ length: 14 }, (_, i) => sortant("ok", 500 + i * 60)),
    ];

    const mesures = mesurer(messages);

    // 6 sur 20, soit 30 % : « parfois ». Le drapeau et le visage vivent dans
    // deux blocs Unicode différents, et une regex trop étroite n'en voit qu'un.
    expect(mesures.styleEmoji?.valeur).toBe("parfois");
    expect(mesures.styleEmoji?.preuve).toMatch(/6 sur 20/);
  });

  it("dit « jamais » quand les emoji sont absents", () => {
    expect(mesurer(sortants("ok", 20)).styleEmoji?.valeur).toBe("jamais");
  });

  it("ne confond pas « rendez-vous » avec du vouvoiement", () => {
    // Le piège : « vous » apparaît dans « rendez-vous », qui ne dit rien de la
    // formalité. Lu naïvement, une conversation tutoyée passerait au
    // vouvoiement.
    const messages = [
      ...Array.from({ length: 16 }, (_, i) => sortant("on se donne rendez-vous où ?", i * 60)),
      ...Array.from({ length: 4 }, (_, i) => sortant("tu viens ?", 2000 + i * 60)),
    ];

    const mesures = mesurer(messages);

    expect(mesures.styleFormality?.valeur).toBe("tutoiement");
  });

  it("reconnaît un vrai vouvoiement", () => {
    const mesures = mesurer(
      Array.from({ length: 20 }, (_, i) => sortant("vous êtes libre demain ?", i * 60)),
    );

    expect(mesures.styleFormality?.valeur).toBe("vouvoiement");
    expect(mesures.styleFormality?.preuve).toMatch(/20 messages vouvoient/);
  });

  it("chronomètre le délai de réponse et en déduit les bornes", () => {
    // C'est ce que le planificateur doit imiter : répondre en quarante secondes
    // quand on met habituellement un quart d'heure se remarque.
    const messages: MessageMesure[] = [];
    for (let index = 0; index < 20; index += 1) {
      messages.push(entrant("tu fais quoi ?", index * 120));
      messages.push(sortant("rien de spécial", index * 120 + 10));
    }

    const mesures = mesurer(messages);

    expect(mesures.medianeReponseSec).toBe(600);
    expect(mesures.minDelaySec?.valeur).toBe(300);
    expect(mesures.maxDelaySec?.valeur).toBe(1200);
    expect(mesures.minDelaySec?.preuve).toMatch(/10 min en médiane \(20 réponses mesurées\)/);
  });

  it("écarte les reprises de conversation du calcul du délai", () => {
    // Une réponse le lendemain matin n'est pas un délai de réponse : l'inclure
    // ferait exploser la médiane et proposer des bornes d'une demi-journée.
    const messages: MessageMesure[] = [];
    for (let index = 0; index < 10; index += 1) {
      messages.push(entrant("coucou", index * 2000));
      messages.push(sortant("salut", index * 2000 + 1));
    }
    messages.push(entrant("tu dors ?", 100_000));
    messages.push(sortant("pardon j'étais pris", 100_000 + 20 * 60));

    const mesures = mesurer(messages);

    expect(mesures.medianeReponseSec).toBe(60);
  });

  it("ne descend jamais sous un plancher humain", () => {
    // Une médiane de deux secondes vient d'un échange en direct ; répondre en
    // une seconde à chaque message, lui, ne ressemble à personne.
    const messages: MessageMesure[] = [];
    for (let index = 0; index < 20; index += 1) {
      messages.push({ direction: "IN", texte: "?", horodatage: new Date(DEBUT + index * 60_000) });
      messages.push({
        direction: "OUT",
        texte: "oui",
        horodatage: new Date(DEBUT + index * 60_000 + 2_000),
      });
    }

    const mesures = mesurer(messages);

    expect(mesures.medianeReponseSec).toBe(2);
    expect(mesures.minDelaySec?.valeur).toBe(15);
    expect(mesures.maxDelaySec?.valeur).toBeGreaterThanOrEqual(45);
  });

  it("mesure qui relance la conversation", () => {
    // Trois reprises au moins, sinon la proportion ne veut rien dire.
    const messages: MessageMesure[] = [];
    for (let jour = 0; jour < 10; jour += 1) {
      // Chaque journée commence par un message de l'utilisateur, sauf deux.
      const debutJour = jour * 24 * 60;
      messages.push(
        jour < 8 ? sortant("bonjour toi", debutJour) : entrant("bonjour", debutJour),
      );
      messages.push(entrant("salut", debutJour + 5));
      messages.push(sortant("ça va ?", debutJour + 10));
    }

    const mesures = mesurer(messages);

    expect(mesures.styleInitiative?.valeur).toBe("souvent");
    expect(mesures.styleInitiative?.preuve).toMatch(/8 fois sur 10 reprises/);
  });

  it("dit « jamais » quand la relance vient toujours d'en face", () => {
    const messages: MessageMesure[] = [];
    for (let jour = 0; jour < 10; jour += 1) {
      const debutJour = jour * 24 * 60;
      messages.push(entrant("tu es là ?", debutJour));
      messages.push(sortant("oui pardon", debutJour + 30));
      messages.push(sortant("j'étais occupé", debutJour + 31));
    }

    const mesures = mesurer(messages);

    expect(mesures.styleInitiative?.valeur).toBe("jamais");
  });

  it("ignore les médias et les messages vides dans les mesures de style", () => {
    // Un message sans texte a bien eu lieu, mais il ne dit rien de la longueur
    // ni des emoji : le compter ferait croire à des messages de zéro caractère.
    const messages = [
      ...sortants("coucou ça va ?", 20),
      ...Array.from({ length: 10 }, (_, i) => ({
        direction: "OUT" as const,
        texte: null,
        horodatage: new Date(DEBUT + (2000 + i) * 60_000),
      })),
    ];

    const mesures = mesurer(messages);

    expect(mesures.sortants).toBe(20);
    expect(mesures.styleLength?.preuve).toMatch(/sur 20 messages/);
  });

  it("ne rend aucune mesure sur un historique vide", () => {
    expect(mesurer([])).toEqual({ medianeReponseSec: null, sortants: 0 });
  });
});
