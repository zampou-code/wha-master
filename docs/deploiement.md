# Runbook de déploiement — Dokploy

Ce document décrit, pas à pas, comment déployer l'application sur Dokploy et
vérifier qu'elle fonctionne correctement. Il est écrit pour être suivi sans
assistance, par quelqu'un qui n'a jamais vu ce dépôt.

Toutes les commandes shell supposent un terminal Unix (macOS/Linux) avec
`openssl` et `curl` installés. Remplacer `$APP_DOMAIN` et `$VPS_IP` par les
valeurs réelles à chaque fois qu'ils apparaissent.

---

## 1. Générer les secrets immuables

```bash
openssl rand -hex 32     # → MASTER_KEY
openssl rand -base64 48  # → BETTER_AUTH_SECRET
openssl rand -hex 32     # → POSTGRES_PASSWORD
openssl rand -base64 24  # → GOWA_WEBHOOK_SECRET
```

**`POSTGRES_PASSWORD` ne doit jamais contenir `/`, `+` ni `@`** : cette
valeur est interpolée telle quelle dans une URL de connexion
(`docker-compose.yml`, `postgres://wha:${POSTGRES_PASSWORD}@postgres:5432/wha`).
`openssl rand -base64` peut produire ces trois caractères ; un `/` y termine
prématurément la partie autorité de l'URL, ce qui fait pointer l'application
vers un mauvais hôte/port et la fait boucler en échec (`migrate deploy`) au
démarrage, sans rien indiquer que la cause est ce caractère dans le mot de
passe. `openssl rand -hex 32` ne produit que des caractères hexadécimaux et
élimine ce risque — l'utiliser pour `POSTGRES_PASSWORD`, jamais `-base64`.

Copier les quatre valeurs générées dans un gestionnaire de mots de passe
**avant** de continuer.

Deux d'entre elles ne doivent **jamais** changer une fois l'application en
production :

- **`MASTER_KEY`** chiffre les clés d'API des fournisseurs IA stockées en
  base (`ProviderConfig.apiKeyEncrypted`). La faire tourner rend
  **illisibles** toutes les clés déjà enregistrées : il faudra les
  ressaisir une par une.
- **`BETTER_AUTH_SECRET`** signe les sessions. La faire tourner déconnecte
  l'utilisateur **à chaque déploiement** qui change sa valeur.

`MASTER_KEY` doit faire exactement 64 caractères hexadécimaux (32 octets) —
c'est ce que produit `openssl rand -hex 32`, et c'est validé strictement au
démarrage de l'application (`src/config/env.ts`, regex
`^[0-9a-fA-F]{64}$`). `BETTER_AUTH_SECRET` doit faire au moins 32 caractères.

Choisir également, sans commande particulière :

- **`ADMIN_EMAIL`** / **`ADMIN_PASSWORD`** — les identifiants du compte
  unique de l'application (mono-utilisateur). `ADMIN_PASSWORD` doit faire au
  moins 12 caractères.
- **`GOWA_BASIC_AUTH`** — au format `identifiant:motdepasse` (par exemple
  `admin:un-mot-de-passe-fort`), protège l'API REST interne de GOWA.

---

## 2. Créer le service Dokploy

1. Créer un projet Dokploy, puis y ajouter un service de type **Compose**.
2. Source : le dépôt Git de ce projet, branche `phase1-socle` (ce sera
   `main` une fois cette branche fusionnée), chemin du fichier Compose :
   `docker-compose.yml`.
3. Onglet **Environment** : renseigner les variables listées dans la table
   de la section 3 ci-dessous.
4. Onglet **Domains** : voir section 4.
5. Déployer.

Le fichier `docker-compose.yml` définit trois services : `app` (l'
application Next.js, construite depuis le `Dockerfile` du dépôt), `gowa`
(l'image `aldinokemal2104/go-whatsapp-web-multidevice:latest`) et
`postgres` (`postgres:16-alpine`). Au démarrage, le conteneur `app` exécute
`pnpm prisma migrate deploy`, puis `pnpm tsx src/scripts/seed-admin.ts` (qui
crée le compte `ADMIN_EMAIL`/`ADMIN_PASSWORD` s'il n'existe pas encore), puis
`pnpm start`.

---

## 3. Variables d'environnement

| Variable | Rôle | Valeur / origine |
|---|---|---|
| `APP_DOMAIN` | Nom de domaine public de l'app ; alimente le label Traefik `traefik.http.routers.wha.rule=Host(\`${APP_DOMAIN}\`)` déjà présent dans `docker-compose.yml` | Domaine possédé par l'utilisateur, avec un enregistrement DNS (A/AAAA) pointant vers l'IP du VPS |
| `POSTGRES_PASSWORD` | Mot de passe du rôle `wha` dans PostgreSQL ; interpolé à la fois dans le service `postgres` et dans le `DATABASE_URL` recalculé pour le service `app` — ne doit jamais contenir `/`, `+` ni `@` (section 1) | `openssl rand -hex 32` (section 1) |
| `DATABASE_URL` | URL de connexion Prisma | Non nécessaire dans Dokploy : le bloc `environment:` du service `app` dans `docker-compose.yml` la recalcule automatiquement (`postgres://wha:${POSTGRES_PASSWORD}@postgres:5432/wha`) et **écrase** toute valeur venant de `.env`. La renseigner à l'identique ne fait pas de mal mais n'a pas d'effet |
| `DATABASE_URL_TEST` | Utilisée uniquement par les tests d'intégration locaux (`tests/int-setup.ts`) | Ne pas renseigner en production |
| `MASTER_KEY` | Chiffre les clés d'API des fournisseurs IA en base. **Immuable** | `openssl rand -hex 32` (section 1) |
| `BETTER_AUTH_SECRET` | Signe les sessions Better Auth. **Immuable** | `openssl rand -base64 48` (section 1) |
| `BETTER_AUTH_URL` | URL publique utilisée par Better Auth | `https://` + `APP_DOMAIN` |
| `ADMIN_EMAIL` | E-mail du compte unique créé au premier démarrage. **Immuable en pratique** : `Dockerfile` enchaîne `migrate deploy && tsx seed-admin.ts && next start`, et `seed-admin.ts` lève une erreur dès qu'un `user` existe déjà sous une autre adresse — avec `restart: unless-stopped`, changer `ADMIN_EMAIL` après le premier démarrage met le conteneur `app` en **boucle de redémarrage permanente**. Pour en changer, voir la procédure de récupération en section 12 | Choisi par l'opérateur |
| `ADMIN_PASSWORD` | Mot de passe du compte unique (≥ 12 caractères). **Ne s'applique qu'au tout premier démarrage** : une fois le compte credential créé, `seed-admin.ts` le détecte et ne fait plus rien (`console.log("... déjà présent, rien à faire.")`) — changer `ADMIN_PASSWORD` ensuite dans Dokploy est un **no-op silencieux**, l'ancien mot de passe reste actif. Voir la procédure de récupération en section 12 | Choisi par l'opérateur |
| `GOWA_BASE_URL` | URL interne du service `gowa` | Fixée par `docker-compose.yml` (`http://gowa:3000`) pour le service `app` — inutile de la renseigner dans Dokploy |
| `GOWA_BASIC_AUTH` | Identifiants HTTP Basic Auth de l'API REST GOWA, format `identifiant:motdepasse` | Choisi par l'opérateur (section 1) |
| `GOWA_WEBHOOK_SECRET` | Secret partagé HMAC qui signe les webhooks envoyés par `gowa` vers `app` (`X-Hub-Signature-256`) | `openssl rand -base64 24` (section 1) |
| `CONTROL_GROUP_JID` | JID du groupe de contrôle WhatsApp | **Laisser vide** — le groupe se choisit dans l'interface, page « Groupe de contrôle ». Cette variable n'est qu'un repli pour les déploiements qui l'avaient déjà renseignée, et le réglage de l'interface l'emporte. |

---

## 4. Domaine

`docker-compose.yml` porte déjà les labels Traefik nécessaires sur le
service `app` uniquement :

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.wha.rule=Host(`${APP_DOMAIN}`)
  - traefik.http.routers.wha.entrypoints=websecure
  - traefik.http.routers.wha.tls.certresolver=letsencrypt
  - traefik.http.services.wha.loadbalancer.server.port=3000
```

Dans Dokploy, onglet **Domains** du service : attacher `APP_DOMAIN` au
service `app`, port **3000**, HTTPS avec certificat **Let's Encrypt**.

Les services `gowa` et `postgres` ne portent **aucun label Traefik** et
n'ont **aucun domaine attaché**, jamais. C'est intentionnel : ce sont des
services internes, accessibles uniquement depuis le réseau Docker `interne`
défini dans le Compose. Ne créer un domaine pour aucun des deux, sous aucun
prétexte — voir la vérification d'isolement en section 6.

---

## 5. Vérifier la santé

```bash
curl -s https://$APP_DOMAIN/api/health
```

Réponse attendue : `{"status":"ok","db":"up"}`.

Cette route (`src/app/api/health/route.ts`) exécute `SELECT 1` sur la base
Postgres ; en cas d'échec elle répond `{"status":"degraded","db":"down"}`
avec un code HTTP 503.

---

## 6. Vérifier l'isolement réseau

C'est la vérification la plus importante : elle prouve la propriété de
sécurité centrale du système. `gowa` expose une API qui peut envoyer un
message WhatsApp à n'importe quel numéro sans authentification forte (seul
`GOWA_BASIC_AUTH`, un identifiant/mot de passe statique, la protège) ; elle
ne doit donc jamais être atteignable depuis Internet.

Depuis une machine extérieure au VPS :

```bash
curl -sS --max-time 5 http://$VPS_IP:3000/api/health ; echo "code=$?"
curl -sS --max-time 5 http://$VPS_IP:5432             ; echo "code=$?"
```

(Le chemin `/api/health` n'a pas d'importance particulière ici — n'importe
quel chemin ferait l'affaire, y compris la racine. Ce qui compte est la
connexion TCP elle-même.)

**Résultat attendu : échec de connexion dans les deux cas** (connexion
refusée ou timeout, `code` non nul). Aucune des deux commandes ne doit
recevoir de réponse HTTP.

Si l'une des deux répond :

- Port 3000 accessible directement sur l'IP du VPS → une entrée `ports:`
  s'est glissée dans le service `app` du Compose, ou un label Traefik est
  mal placé (par exemple attaché à `gowa` au lieu de `app`).
- Port 5432 accessible directement sur l'IP du VPS → une entrée `ports:`
  s'est glissée dans le service `postgres`. Ceci exposerait la base entière,
  y compris l'historique complet des conversations, directement sur
  Internet.

Dans les deux cas : ne pas continuer le déploiement. Corriger
`docker-compose.yml`, redéployer, puis relancer cette vérification avant de
passer à la suite.

---

## 7. Premier login et appairage WhatsApp

1. Ouvrir `https://$APP_DOMAIN/login`, se connecter avec `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`. La connexion réussie redirige automatiquement vers
   `/connexion`.
2. Sur `/connexion`, un QR code s'affiche (généré côté client à partir du
   code renvoyé par `GET /api/whatsapp/qr`, qui interroge GOWA sur
   `/app/login`).
3. Dans WhatsApp sur le téléphone à appairer : **Réglages → Appareils
   connectés → Associer un appareil**, puis scanner le QR affiché.
4. Attendre que la page affiche « Appareil appairé (…) », suivi du JID du
   compte. La page interroge `GET /api/whatsapp/status` toutes les 3
   secondes ; l'affichage se met à jour automatiquement, aucune action
   supplémentaire n'est nécessaire.

---

## 8. Vérifier l'ingestion de bout en bout

Depuis un **autre** téléphone, envoyer un message WhatsApp vers le numéro
qui vient d'être appairé.

Puis, ouvrir un terminal dans le conteneur `postgres` (dans Dokploy, onglet
**Terminal** du service `postgres` ouvre un shell directement dans ce
conteneur) et lancer :

```bash
psql -U wha -d wha -c \
  'SELECT "waMessageId", direction, source, text FROM "Message" ORDER BY "createdAt" DESC LIMIT 5;'
psql -U wha -d wha -c \
  'SELECT jid, mode FROM "Contact";'
```

Si l'accès se fait par SSH sur le VPS plutôt que par le terminal intégré de
Dokploy, l'équivalent est, depuis le répertoire du projet Compose :

```bash
docker compose exec postgres psql -U wha -d wha -c \
  'SELECT "waMessageId", direction, source, text FROM "Message" ORDER BY "createdAt" DESC LIMIT 5;'
docker compose exec postgres psql -U wha -d wha -c \
  'SELECT jid, mode FROM "Contact";'
```

Résultat attendu :

- Le message envoyé apparaît dans `Message`, avec `direction = IN` et
  `source = HUMAN`.
- **Le contact apparaît dans `Contact` avec `mode = OFF`.**

**Si un seul contact apparaît dans un autre mode que `OFF`** (`DRAFT` ou
`AUTO`), le principe P1 (« aucun contact actif par défaut ») est violé.
**Arrêter immédiatement** — ne pas continuer vers la section 9, ne pas
appairer d'autres numéros — et signaler le problème avant d'aller plus
loin.

---

## 9. Vérifier la persistance au redéploiement

1. Depuis Dokploy, déclencher un second déploiement du service (redeploy).
2. Une fois le déploiement terminé, rouvrir `https://$APP_DOMAIN/connexion`.

Résultat attendu : la page affiche toujours « Appareil appairé », **sans
nouveau QR**, et la session WhatsApp reste ouverte.

Si un QR réapparaît, le volume `gowa-session` (déclaré dans
`docker-compose.yml`, monté sur `/app/storages` dans le conteneur `gowa`)
n'est pas monté correctement, ou a été recréé au lieu d'être réutilisé.
Vérifier dans Dokploy que le volume nommé `gowa-session` persiste bien
entre deux déploiements du même service.

---

## 10. Deux points à vérifier sur l'instance réelle

Ces deux comportements de GOWA n'ont pas pu être déterminés à partir du
code source de GOWA seul ; ils doivent être observés une fois l'instance en
ligne.

### 10.1 Unité de `duration` sur `GET /app/login`

Dans les journaux du service `app` (ou en interrogeant directement
`GET /app/login` sur `gowa` avec les identifiants `GOWA_BASIC_AUTH`),
relever la valeur brute du champ `results.duration` renvoyée à l'étape
d'appairage (section 7).

Le code actuel (`src/gowa/client.ts`, méthode `getLoginQr()`) suppose que
cette valeur est déjà en secondes :

```ts
durationSec: Math.round(results.duration),
```

Si la valeur observée est de l'ordre de plusieurs milliards (typique d'un
`time.Duration` Go sérialisé en nanosecondes, pour une durée de QR
d'environ 20 à 30 secondes), corriger ainsi :

```ts
durationSec: Math.round(results.duration / 1e9),
```

et mettre à jour le test correspondant dans `tests/gowa/client.test.ts`
(la valeur mockée `duration: 30` à la ligne 41 et l'assertion
`expect(qr.durationSec).toBe(30)` à la ligne 45) pour refléter la bonne
échelle — par exemple mocker `duration: 30_000_000_000` si l'unité réelle
est la nanoseconde, en gardant l'assertion `toBe(30)`.

Si la valeur observée est déjà de l'ordre de 20 à 30, aucune modification
n'est nécessaire.

### 10.2 Présence de la clé `results` sur les réponses d'envoi

`sendSchema` et `presenceSchema`, dans `src/gowa/types.ts`, sont tous deux
construits via l'enveloppe commune qui exige une clé `results` :

```ts
const enveloppe = <T extends z.ZodTypeAny>(results: T) =>
  z.object({ status: z.number().optional(), code: z.string(), message: z.string(), results });
```

Si GOWA omet la clé `results` sur une réponse de succès à `POST
/send/message` ou `POST /send/chat-presence`, l'appel échoue avec une
`GowaError` (« Réponse GOWA inattendue ») alors même que le message a bien
été envoyé.

Envoyer un message de test via `POST /send/message` sur l'API GOWA
directement (avec `GOWA_BASIC_AUTH`) et observer la forme réelle de la
réponse. Si `results` est absent en cas de succès, rendre le champ
optionnel dans `src/gowa/types.ts` pour `sendSchema` et `presenceSchema`
uniquement (pas `statusSchema` ni `loginSchema`, déjà validés aux sections 7
et 10.1).

Ces deux méthodes (`sendText`, `sendChatPresence`) ne sont appelées par
aucun code avant la phase 3 : ceci est une note à corriger, pas un
bloqueur pour la mise en production de la phase 1.

### 10.3 Format réel des webhooks GOWA

Comme pour 10.1 et 10.2, ce point n'a pas pu être vérifié sur le code
source de GOWA seul — mais c'est le seul des trois dont l'échec silencieux
fait perdre des messages : si le nom d'en-tête, le préfixe de signature,
les noms de variables d'environnement GOWA ou les noms de champs internes
du payload diffèrent de ce que suppose le code, **tous les messages entrant
sur le compte sont perdus sans le moindre diagnostic** tant que la
correction ci-dessous (voir section 2 de la revue) n'est pas en place — et
même une fois en place, la panne devient visible mais pas résolue tant que
le contrat n'a pas été corrigé.

Le code suppose actuellement :

- En-tête HTTP `X-Hub-Signature-256`, valeur au format `sha256=<hmac hex>`
  (`src/ingest/signature.ts`).
- Côté `gowa`, les variables d'environnement `WHATSAPP_WEBHOOK` (URL cible),
  `WHATSAPP_WEBHOOK_SECRET` (secret HMAC) et `APP_BASIC_AUTH` (identifiants
  de l'API REST GOWA) — voir `docker-compose.yml`.
- Côté payload interne (`src/ingest/payload.ts`, `webhookSchema`) : une clé
  `event` (chaîne, ex. `"message"`), un objet `payload` contenant `id`,
  `chat_id`, `from`, `from_name` (optionnel), `body` (optionnel),
  `timestamp` (chaîne), `is_from_me` (booléen), `replied_to_id` (optionnel).

**À faire dès réception du tout premier message** (section 8) : capturer le
corps brut d'un webhook GOWA et ses en-têtes exactement tels qu'envoyés (par
exemple en journalisant temporairement `request.headers` et `corpsBrut`
dans `src/app/api/webhook/gowa/route.ts`, ou via un intercepteur HTTP entre
`gowa` et `app`), et comparer :

- le nom et le format de l'en-tête de signature à ce qu'attend
  `verifierSignature` ;
- les noms des trois variables d'environnement GOWA ci-dessus à ce que
  `gowa` lit réellement (se référer à la documentation de l'image
  `aldinokemal2104/go-whatsapp-web-multidevice` pour la version déployée) ;
- les noms de champs du payload interne à ce qu'attend `webhookSchema`.

**Avec la correction de la section 2 de la revue en place** (`safeParse`
distinguant un événement `message` malformé d'un événement non géré), un
écart sur les noms de champs internes du payload ne produit plus un 200
silencieux : il produit désormais une réponse **400** et une ligne de
journal `Payload de message invalide` contenant le détail des erreurs Zod
dans les journaux du service `app` — c'est le signal à chercher en premier
si aucun message n'apparaît en base (voir le tableau de la section 12).
Un écart sur l'en-tête de signature, lui, continue de produire un **401**
(comportement déjà correct et déjà couvert par les tests).

---

## 11. Sauvegardes planifiées

Dans Dokploy, planifier une sauvegarde **quotidienne** des deux volumes
déclarés dans `docker-compose.yml` :

- **`pg-data`** (données PostgreSQL) — sa perte fait perdre l'intégralité
  de l'historique des conversations, des contacts, des politiques par
  contact, et de toute la configuration (comptes, clés de fournisseurs IA
  chiffrées, etc.). C'est la perte la plus coûteuse possible.
- **`gowa-session`** (session WhatsApp de GOWA) — sa perte oblige
  simplement à ré-appairer l'appareil en scannant un nouveau QR
  (section 7). Aucune donnée métier n'est perdue.

---

## 12. En cas de problème

| Symptôme | Cause probable | Action |
|---|---|---|
| `/api/health` répond 503 | PostgreSQL n'est pas démarré ou pas prêt | Vérifier le healthcheck du service `postgres` (`pg_isready -U wha -d wha`) dans Dokploy |
| QR redemandé après un déploiement | Le volume `gowa-session` n'est pas monté ou pas réutilisé | Vérifier la section `volumes` du `docker-compose.yml` et que le volume `gowa-session` persiste entre deux déploiements |
| Webhook en 401 dans les journaux de `app` | `GOWA_WEBHOOK_SECRET` diffère entre `app` et `gowa` | Les deux services lisent la même variable Dokploy : vérifier qu'elle est identique des deux côtés |
| Aucun message en base après un envoi | `WHATSAPP_WEBHOOK` mal pointé côté `gowa` | Doit valoir exactement `http://app:3000/api/webhook/gowa` (variable d'environnement du service `gowa` dans `docker-compose.yml`, non modifiable depuis Dokploy). **Regarder d'abord les journaux de `app`** avant de suspecter l'URL : si le webhook était mal pointé, il n'y aurait *aucune* requête du tout côté `app` ; si en revanche les journaux montrent une ligne `Payload de message invalide` avec un code 400, l'URL est correcte et c'est le format du payload qui ne correspond pas au contrat attendu — voir section 10.3 |
| `Payload de message invalide` (400) dans les journaux de `app` pour chaque message entrant | Le format réel des webhooks GOWA (en-têtes, enveloppe, noms de champs) diverge du contrat supposé dans `src/ingest/payload.ts` | Comparer un webhook brut capturé (section 10.3) au schéma `webhookSchema` ; corriger `src/ingest/payload.ts` en conséquence |
| Déconnexion à chaque déploiement | `BETTER_AUTH_SECRET` a été régénéré | Le figer une fois pour toutes dans les variables d'environnement Dokploy (voir section 1) |
| Mot de passe administrateur oublié | `ADMIN_PASSWORD` ne s'applique qu'au premier démarrage (voir section 3) ; le changer dans Dokploy ensuite n'a aucun effet | Depuis un terminal dans le conteneur `postgres` : `psql -U wha -d wha -c "DELETE FROM \"user\" WHERE email = '<ADMIN_EMAIL actuel>';"`. La suppression du `user` entraîne, par les relations `onDelete: Cascade` du schéma Prisma, celle de ses `session` et `account` associés. Redéployer (ou relancer le conteneur `app`) : `seed-admin.ts` recrée alors le compte à partir des valeurs courantes de `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Aucune autre donnée (`Contact`, `Message`, etc.) n'est affectée |
| `ADMIN_EMAIL` doit changer | Voir ci-dessus : c'est la même procédure. Sans elle, `seed-admin.ts` lève une erreur à chaque démarrage (« Un compte existe déjà avec une autre adresse ») et `app` boucle en échec avec `restart: unless-stopped` | Supprimer le `user` existant comme ci-dessus, puis mettre à jour `ADMIN_EMAIL` dans Dokploy avant de redéployer |
| `pnpm test:int` échoue en local avec une erreur de connexion PostgreSQL | Le conteneur de test `wha-pg` publie PostgreSQL sur le port **5434** (et non 5432, occupé par un autre service sur la machine), alors que `.env` (git-ignoré) et `.env.example` pointent `DATABASE_URL_TEST` vers le port 5432 | Lancer les tests d'intégration avec le port explicite : `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int` |
