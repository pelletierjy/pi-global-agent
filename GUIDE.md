# Guide de la flotte PI Durable

> Comment c'est construit, comment ça fonctionne, et des exemples complets.
> Référence API détaillée : [`README.md`](README.md) · Concept d'origine : [Pi Durable — Earendil](https://earendil.com/posts/pi-durable/)

---

## 1. C'est quoi, en trois briques

| Brique | Rôle |
|---|---|
| **Pi Durable** | Le *harness* qui exécute des conversations d'agent (messages → modèle → outils) avec la règle fondamentale : **tout est commité sur disque avant d'être exécuté**. Chaque étape est une *task* avec checkpoint → reprise après crash, `requestId` exactly-once, compaction automatique du contexte. |
| **Durable Object (Cloudflare)** | Un micro-serveur *étatful* avec son propre SQLite, qui n'existe que lorsqu'on l'appelle (≈0 € au repos) et dont le disque survit à tout : redéploiement, crash, semaines sans requête. |
| **Worker** | La façade HTTP : auth (`AGENT_TOKEN`), routage vers le DO, fédération, cron, dashboard. |

**L'équation :** `Pi Durable` dans un `Durable Object` = un agent persistant, accessible partout, qui ne perd rien.

## 2. Topologie

```
   vous / scripts / dashboard / n'importe quel client
        │  HTTPS + Bearer AGENT_TOKEN
        ▼
 ┌─────────────────────────────────────────────────────┐
 │ pi-global-agent  (le HUB)                           │
 │  • harness Pi Durable (conversations racine)        │
 │  • cron hebdo → runSweep (digest + dispatch)        │
 │  • /federation, /federation/tasks, /federation/sweep │
 │  • /dashboard (5 cartes + flux WS)                  │
 └───────────────┬─────────────────────────────────────┘
                 │  federation (HTTPS Worker→Worker,
                 │  global_fetch_strictly_public)
   ┌─────────────┼──────────────┬──────────────────┐
   ▼             ▼              ▼                  ▼
 pi-conversia- pi-homework-  pi-scalesviewer  pi-globalvsthost
 core          tutora
```

| Worker | URL (workers.dev, config `jyp.solutions` prête mais sans zone DNS) |
|---|---|
| hub | `https://pi-global-agent.need-homework.workers.dev` |
| projets | `https://pi-<nom>.need-homework.workers.dev` (conversia-core, homeworktutora, scalesviewer, globalvsthost) |

Auth : même `AGENT_TOKEN` partout (variables d'env `PI_AGENT_URL` / `PI_AGENT_TOKEN` déjà posées sur la machine).

## 3. Ce que contient chaque Durable Object

Un seul SQLite partagé (important : `DurableObjectSqliteDatabase` — les écritures hôte passent par la **même file de transactions** que Pi, donc jamais de course) :

| Tables | Contenu | API |
|---|---|---|
| **`pi_*` (préfixe Pi)** | Harness Pi Durable : conversations, transcripts, docs `pi.agent`/`pi.usage`/… , tasks de génération | `/conversations…` |
| `tasks` | File de tâches mission-control : `pending → in_progress → done/failed`, claim atomique (1 seule requête SQL) | `/tasks`, `/tasks/claim` |
| `notes` | Mémoire durable de session (append-only) | `/notes` |
| `conversations` | Index des conversations créées (l'hérite `root` existe toujours) | `/conversations` |
| `exec_requests` | Passerelle d'exécution locale (scénario E) : `pending → running → done/failed` | `/exec/*` + outils du modèle |
| KV `mc:state` | État affiché `{status, currentTask}` (sync WS) | `/state/set` |
| KV `ws:<id>` | Conversation ciblée par socket (re-attach après hibernation) | — |

**Modèles** : le DO reçoit les clés API via les *bindings* du Worker (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`) lues par un `authContext` maison (⚠️ `process.env` n'est pas exploitable dans workerd — cf. `buildModels()` dans `src/index.ts`). Défaut : `google/gemini-3.8-flash` ; changeable par conversation.

## 4. Cycle de vie d'une requête

```
POST /conversations/root/messages {"content":"..."}
1. Worker   : vérifie Bearer AGENT_TOKEN → route vers le DO singleton
2. DO       : harness.submit()  → commit SQLite (l'entrée est DURABLE immédiatement)
3.          : task "generation" → checkpoint → appel Google/OpenRouter → réponse
4.          : commit du transcript + usage (tokens/coût)
5. Réponse {status:"done", text:"..."}
   ├─ les WS connectés reçoivent {"type":"events", …} en direct
   └─ si crash entre 3 et 4 → au réveil, harness.resume() reprend le checkpoint
      (jamais de doublon : requestId exactly-once)
```

Même mécanisme pour `/tasks` (INSERT dans la même DB) : la durabilité est gratuite, la sémantique `claim` est atomique.

## 5. Exemples complets

### 5.1 Premier contact
```bash
export PI_AGENT_URL=https://pi-global-agent.need-homework.workers.dev
export PI_AGENT_TOKEN=<token>

curl -H "Authorization: Bearer $PI_AGENT_TOKEN" "$PI_AGENT_URL/health"          # ouvert
curl -H "Authorization: Bearer $PI_AGENT_TOKEN" "$PI_AGENT_URL/status"
curl -X POST "$PI_AGENT_URL/conversations/root/messages" \
     -H "Authorization: Bearer $PI_AGENT_TOKEN" -H "Content-Type: application/json" \
     -d '{"content":"Salut, qui es-tu ?"}'
# → {"status":"done","text":"…"}
```

### 5.2 Mémoire durable (le rituel le plus utile)
```bash
curl -X POST "$PI_AGENT_URL/notes" -H "Authorization: Bearer $PI_AGENT_TOKEN" \
     -H "Content-Type: application/json" -d '{"body":"limits restent dans models/constants.ts"}'
curl -H "Authorization: Bearer $PI_AGENT_TOKEN" "$PI_AGENT_URL/notes?limit=5"
```
Toute session future, sur n'importe quelle machine, lit ces notes.

### 5.3 File de tâches (boucle délégué/travailleur)
```bash
curl -X POST "$PI_AGENT_URL/tasks" -H "Authorization: Bearer $PI_AGENT_TOKEN" \
     -H "Content-Type: application/json" -d '{"title":"Fix flaky test","body":"tests/…"}'
curl -X POST "$PI_AGENT_URL/tasks/claim"  -H "Authorization: Bearer $PI_AGENT_TOKEN"  # prise atomique
curl -X POST "$PI_AGENT_URL/tasks/1" -H "Authorization: Bearer $PI_AGENT_TOKEN" \
     -H "Content-Type: application/json" -d '{"status":"done","result":"corrigé"}'
```

### 5.4 Fédération (hub)
```bash
curl -X POST "$PI_AGENT_URL/federation/sweep" -H "Authorization: Bearer $PI_AGENT_TOKEN"
# → digest de toutes les files, sauvegardé en note, + dispatch de SWEEP_TASK (dédupliqué)

curl "$PI_AGENT_URL/federation/tasks" -H "Authorization: Bearer $PI_AGENT_TOKEN"   # vue résultats
curl -X POST "$PI_AGENT_URL/federation/task?peer=scalesviewer" \
     -H "Authorization: Bearer $PI_AGENT_TOKEN" -H "Content-Type: application/json" \
     -d '{"title":"…"}'                                                             # dispatch ciblé
```
Cron intégré (hub, `triggers.crons` dans `wrangler.jsonc`) : **lundi 13h UTC** = même fonction que `/federation/sweep`.

### 5.5 Dashboard temps réel (D)
Navigateur : `https://pi-global-agent.need-homework.workers.dev/dashboard?token=<token>`
→ 5 cartes (état, files, notes, modèle) rafraîchies toutes les 30 s + feed d'événements WS en direct (auto-reconnexion).

### 5.6 Exécution réelle dans vos repos (E)
```bash
# une fois par session, sur la machine qui possède les dépôts :
PI_AGENT_TOKEN=<token> node D:\Repos\pi-global-agent\runner.mjs
```
Puis demandez à un agent, par exemple :
```bash
curl -X POST "https://pi-conversia-core.need-homework.workers.dev/conversations/root/messages" \
     -H "Authorization: Bearer $PI_AGENT_TOKEN" -H "Content-Type: application/json" \
     -d '{"content":"Appelle run_command avec la commande: git status --short puis résume le résultat"}'
```
Chaîne : modèle → outil `run_command` → `exec_requests` (DO, le modèle attend) → **runner sortant** → exécution locale dans la racine du projet → résultat remonté → réponse. Fichiers confinés à la racine (escape rejeté), sorties plafonnées.

### 5.7 Brief du matin (B)
```bash
node D:\Repos\pi-global-agent\scripts\morning.mjs        # brief complet (re-essais intégrés)
node D:\Repos\pi-global-agent\scripts\morning.mjs --no-ask  # données brutes uniquement
```

### 5.8 WebSocket (temps réel)
```js
const ws = new WebSocket(`wss://pi-global-agent.need-homework.workers.dev/ws?conversation=root&token=${token}`);
ws.onmessage = e => console.log(JSON.parse(e.data));  // hello(snapshot) → events → changed
setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 25000);  // heartbeat + re-attach post-hibernation
```

## 6. Comment c'est fait (implémentation)

Tout le code vit dans `pi-agent/` de chaque dépôt (paquet npm isolé, hors du toolchain de l'app) :

| Fichier | Rôle |
|---|---|
| `src/index.ts` | Worker (fetch/scheduled/fédération/auth) + `class PiAgent` (DO) : harness, tables hôte, outils modèle, WS, endpoints |
| `src/dashboard.ts` | HTML/JS du dashboard, servi à `/dashboard` (pas de build) |
| `scripts/morning.mjs` | Scénario B (node, zéro dépendance) |
| `runner.mjs` | Exécuteur local sortant (E) |
| `wrangler.jsonc` | Binding DO (`PiAgent`, `new_sqlite_classes`), vars (`AGENT_NAME`, `PEERS`, `SWEEP_TASK`), cron (hub), flags (`nodejs_compat`, `global_fetch_strictly_public`¹) |
| `.dev.vars` (gitignoré) | `AGENT_TOKEN` + clés provider pour `wrangler dev` |

¹ Requis car un Worker qui appelle un autre Worker du **même zone** reçoit l'erreur `1042` sans ce flag (d'où les appels fédération qui marchent depuis le hub uniquement).

**Points de design non évidents :**
- **Adaptateur partagé** : `openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" })` pour Pi + `DurableObjectSqliteDatabase` pour les tables hôte → une seule file de transactions (cf. doc Pi Durable « sharing the database »).
- **Auth providers** : `createModels({ authContext })` lit les *bindings* Worker, pas `process.env` (invisible dans workerd).
- **WebSocket/hibernation** : identité par socket via `ws.serializeAttachment()` — les DO WebSockets n'ont **pas** de `.id` (bug corrigé après review Cursor); re-attach au réveil.
- **Claim atomique** : une seule requête `UPDATE … WHERE id = (SELECT …) RETURNING *`, pas de lecture-modification-écriture.
- **Les DO ne chargent le nouveau code qu'au redémarrage** → le runner (polling 800 ms) les maintient en vie : **stopper le runner avant `wrangler deploy`, relancer après**.

## 7. Exploitation

```bash
# Déploiement (TOUJOURS dans l'ordre) :
Stop-Process (runner)                      # 1. sinon les DO gardent l'ancien code
npm run typecheck                          # 2.
npx wrangler deploy                        # 3. (×5 dossiers)
node runner.mjs &                          # 4. relancer le runner

# Secrets (wrangler secret put,×5) :
#   AGENT_TOKEN (existant) · OPENROUTER_API_KEY · GEMINI_API_KEY
# Modèles : défaut google/gemini-3.8-flash ; par conversation :
curl -X POST "$PI_AGENT_URL/conversations/root/configure" … \
     -d '{"agent":{"model":{"provider":"groq","modelId":"llama-3.3-70b-versatile"}}}'
```

Pièges connus : providers « free » instables (re-essais dans `morning.mjs`) ; le cutover `jyp.solutions` attend une zone DNS (config `routes` commentée prête) ; WiX OSMF EULA accepté pour le pipeline release de GlobalVstHost.

## 8. Historique

Construit en 10 PRs mergées (fleet initiale Pi Durable → fixes Bugbot → scénarios C/D/E → docs) + la release **v1.3.4.0** de GlobalVstHost. Docs annexes : `README.md` (référence API), `AGENTS.md` de conversia-core (pointer), corps des PRs (décisions par incrément).
