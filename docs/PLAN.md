# Radar IA temps réel - plan d'action

## 1. Contexte et objectif supérieur (cadré avec Simon le 22/09/2026)

**Objectif supérieur :** repérer, avant la presse, les sujets IA qui vont faire l'actualité dans les 24 à 72 heures, pour publier vite (LinkedIn en français, LinkedIn ou X en anglais) et pour anticiper. Périmètre : l'IA en général, monde entier, anglais et français.

**Signaux jugés fiables par Simon :** montée sur des sources amont avant la presse ; accélération mesurée sur plusieurs sources indépendantes ; annonce officielle d'un acteur majeur. Le LLM n'est pas un signal : il sert à regrouper, nommer et résumer.

**Sortie :** une page publique à URL non listée, consultable à tout moment, trois vues : radar (top du moment), briefs courts bilingues par sujet, flux chronologique filtrable. Plus un flux RSS et un JSON du radar.

**Contraintes :** budget total sous 15 euros par mois, cible sous 2 euros ; aucune violation de conditions d'utilisation (pas de scraping X, LinkedIn, Telegram) ; X exclu par défaut (facturation à l'usage, trop cher en veille horaire) ; comptes gratuits acceptés : Bluesky, Reddit developer app, GitHub, Cloudflare.

**Ce que la littérature permet d'espérer :** les réseaux et communautés amont devancent la presse de quelques heures, pas de jours, et surtout sur la longue queue des sujets de niche (Petrovic et al. 2013). L'objectif mesurable est donc une avance médiane de 3 heures et plus sur la presse tech, et une couverture de sujets que la presse grand public ne traite pas.

**Lien avec `ai_ecosystem` :** capacité distincte de la cartographie (qui suivre) : le radar répond à « qu'est-ce qui monte, maintenant ». Il vit dans un dépôt GitHub public séparé (`ai-radar`) car GitHub Actions n'est gratuit sans plafond qu'en dépôt public, et `ai_ecosystem` contient des données personnelles et un `.env`. Il réutilise par copie quatre briques déjà écrites et testées : `src/core/text.mjs` (normalisation, HTML vers texte), `src/core/fetch.mjs` (robots, délais, cache, erreurs classées), `src/core/llm.mjs` (client compatible OpenAI, coût journalisé), `parseFeed` de `src/listening/poll.mjs`. Les acteurs vérifiés de la cartographie alimentent plus tard le lexique d'entités du radar.

## 2. Faits vérifiés le 22/09/2026 qui fixent les choix

- Hacker News : API Firebase sans limite, Algolia `search_by_date` (points, commentaires, dates). Latence : secondes. Meilleur signal amont.
- Hugging Face : `/api/models?sort=trendingScore`, `/api/daily_papers` (upvotes, dépôt GitHub, étoiles). 500 requêtes / 5 min sans jeton. Signal quasi exclusif sur les modèles open-weights.
- Bluesky : `getTrends`, `getAuthorFeed`, feeds publics sans compte ; `searchPosts` exige un compte gratuit avec mot de passe d'application. 3 000 requêtes / 5 min / IP.
- Reddit : `.json` anonyme = 403 depuis mai 2026 ; `.rss` fonctionne mais sans score et 429 dès la deuxième requête rapide ; OAuth gratuit sur approbation manuelle (2 à 4 semaines). Utilisable en mode dégradé : 1 requête par minute, présence dans `top.rss?t=hour`.
- OpenRouter `/api/v1/models` : les nouveaux modèles API apparaissent le jour J, sans clé.
- GitHub : recherche 10 requêtes / min sans jeton, 30 avec ; vélocité d'étoiles à calculer par snapshots. GH Archive horaire gratuit pour plus tard.
- arXiv : une annonce par jour à 20 h heure de l'Est ; jamais un signal horaire. Wikipedia pageviews : J+1 ; confirmation seulement.
- Google News RSS `when:1h` : items de moins de 40 minutes, 100 par flux, EN et FR. Thermomètre de « repris par la presse ». GDELT : 429 fréquents, réservé à l'évaluation nocturne.
- Kalshi et Manifold : API publiques sans clé, séries dédiées aux sorties de modèles. Polymarket bloqué en France.
- X : plus de palier gratuit, facturation à l'usage. Feedly et Inoreader : API payantes. LinkedIn, Discord : impossibles.
- Hébergement : GitHub Actions cron minimum 5 min, retards de 5 à 30 min aux heures pleines, minutes illimitées en dépôt public. Cloudflare Workers gratuit limité à 10 ms CPU par exécution : inadapté au collecteur, adapté aux embeddings (Workers AI, 10 000 neurones par jour gratuits). Oracle Always Free : seule option pour du streaming permanent, réservée à une phase ultérieure.
- Coûts unitaires : embeddings OpenAI `text-embedding-3-small` 0,02 USD par million de tokens ; `gpt-5.4-nano` déjà benchmarké ; Groq gratuit 200 000 tokens par jour.

## 3. Architecture cible

Un dépôt public `ai-radar`, Node 22 sans dépendance npm obligatoire, SQLite via `node:sqlite`, six scripts enchaînés par un workflow GitHub Actions toutes les 30 minutes, une page statique sur GitHub Pages.

```
collect.mjs  ->  items(source, famille, url_canon, titre, texte, ts, score_brut, snapshot_ts)
cluster.mjs  ->  embeddings + leader clustering (cos >= 0,80) -> clusters(centroïde, première_détection)
score.mjs    ->  z-score et Kleinberg sur entités, n_familles, vélocités normalisées, statut presse -> scores
brief.mjs    ->  LLM : nom du sujet, « pourquoi maintenant », angle, FR + EN, pour les 30 premiers clusters
render.mjs   ->  index.html (radar, briefs, flux), radar.json, radar.xml
evaluate.mjs ->  nocturne : Google News et GDELT à J+1, J+2, J+3 -> précision@10, avance médiane, section « Hier, nos appels »
```

**État persistant :** `radar.sqlite` (items 14 jours, clusters et scores 90 jours) plus `state/*.json` (curseurs par source). Committés sur une branche orpheline `state` réécrite à chaque run par un seul commit forcé, pour que l'historique Git ne grossisse pas. Le code reste sur `main`. La page est déployée par artefact Pages depuis le workflow.

**Familles de sources** (indépendance = signal) : A agrégateurs tech (HN, Lobsters, Techmeme) ; B Reddit ; C Bluesky et Mastodon ; D recherche (arXiv, HF papers) ; E code et modèles (GitHub, HF Hub, OpenRouter) ; F annonces officielles et blogs experts ; G presse (Google News EN et FR, presse tech) ; H marchés de prédiction. La famille G ne compte pas dans l'anticipation : elle fait basculer le statut en « repris par la presse ».

**Extraction d'entités et de termes :** lexique d'entités IA versionné dans `config/lexicon.json` (labos, modèles, produits, personnes, acteurs vérifiés de `ai_ecosystem`) plus n-grammes de titres (1 à 3 mots, stop words FR et EN). Aucun LLM ici.

**Score explicable v1** (poids manuels, affichés au survol) :

```
S = 25·min(1, n_familles_6h/3) + 20·min(1, z_max/6) + 15·min(1, points_HN_par_h/10)
  + 10·min(1, étoiles_GitHub_24h/500) + 10·min(1, upvotes_HF/20)
  + 10·[annonce officielle famille F] + 10·min(1, posts_Bluesky_6h/200)
```

Statut affiché à part : `presse_avant_détection` et `presse_depuis_détection`. Score élevé sans presse = anticipation ; avec presse = confirmation. Après 4 à 6 semaines de données étiquetées, régression logistique sur les mêmes composantes (v2), poids toujours affichables.

**Détection de burst :** z-score par terme sur fenêtres horaires avec baseline 7 jours saisonnalisée par heure de la semaine, plancher Poisson `√μ`, déclenchement si `z ≥ 3` et `compte ≥ 5` et `compte ≥ 2·μ`. Kleinberg (`s = 2`, `γ = 1`, 168 fenêtres) pour le poids des bursts persistants. Formules détaillées dans le rapport de recherche à archiver dans le dépôt (`docs/research/`).

**Regroupement :** dédoublonnage par URL canonique (suppression `utm_*`, résolution des redirections Google News) et SimHash des titres ; embedding du titre plus 200 caractères via OpenAI `text-embedding-3-small` (0,11 USD par mois pour 3 000 items par jour ; repli Cloudflare Workers AI `bge-m3` gratuit en lot 3) ; leader clustering incrémental cos ≥ 0,80, doublon ≥ 0,92, fusion périodique ≥ 0,90, expiration après 72 h sans item.

**Page :** liste triée par score ; décomposition du score au survol ; sparkline items par heure sur 24 h ; horodatage de première détection et âge ; badges par famille avec valeur brute, cliquables vers les items ; puce « pas encore repris par la presse » ou « repris : n articles, premier à hh:mm » ; filtres émergent seulement et 6 h / 24 h / 72 h ; onglet briefs FR et EN ; onglet flux brut filtrable par source et score ; section « Hier, nos appels » avec précision@10, avance médiane, sujets manqués.

## 4. Sources retenues pour la v1 et cadence

| Famille | Source | Accès | Cadence | Clé |
|---|---|---|---|---|
| A | HN Firebase `topstories`, `newstories` (snapshot rangs et points) et Algolia dernière heure | JSON | 30 min | non |
| A | Lobste.rs `hottest.json`, `/t/ai.rss` ; Techmeme `feed.xml` | JSON, RSS | 30 min | non |
| B | Reddit `new.rss` et `top.rss?t=hour` sur 8 subreddits, 1 requête par minute, tolérance 429 | RSS | 30 min | non (OAuth plus tard) |
| C | Bluesky `getTrends`, `getAuthorFeed` sur 50 comptes curés, `searchPosts` sur 20 mots-clés | XRPC | 30 min | compte gratuit + app password |
| C | Mastodon `timelines/tag/{ai,llm,machinelearning}` sur 3 instances, `trends/links` | JSON | 30 min | non |
| D | HF `daily_papers` ; arXiv RSS cs.AI+cs.CL+cs.LG+cs.CV | JSON, RSS | 30 min ; 1 fois par jour à 02 h UTC | non |
| E | HF Hub `models`, `datasets`, `spaces` triés par `trendingScore` ; OpenRouter `/models` (diff) ; GitHub search `created:>J-30 stars:>50` et `releases.atom` de 30 dépôts clés | JSON, Atom | 30 min | jeton GitHub gratuit |
| F | Blogs OpenAI, DeepMind, Google AI, Google Research, HF, Microsoft Research, NVIDIA, Mistral, flux tiers Anthropic ; Simon Willison, Latent Space, Interconnects, Import AI, The Rundown, TLDR AI, LessWrong ; forums Discourse OpenAI, HF, Cursor | RSS | 30 min | non |
| G | Google News RSS EN et FR `when:1h` sur 6 requêtes ; presse tech EN (TechCrunch AI, The Verge AI, Ars, MIT TR, Wired AI, The Information) et FR (Le Monde IA, Numerama, FrenchWeb, Maddyness, ActuIA) | RSS | 30 min | non |
| H | Kalshi séries IA, Manifold `search-markets` | JSON | 1 fois par heure | non |

Volume attendu : 2 000 à 4 000 items par jour, environ 150 requêtes HTTP par run. Reportés en lot 4 ou plus tard : GH Archive horaire, Wikimedia EventStreams et GDELT en continu (streaming), Product Hunt (jeton), Threads (permission Meta), X (1 à 2 recherches par jour si Simon le décide, environ 1,5 euro par mois), Telegram (conditions d'utilisation).

## 5. Hébergement et coût

| Poste | Choix | Coût mensuel |
|---|---|---:|
| Exécution | GitHub Actions, dépôt public, cron `7,37 * * * *` (décalé des heures pleines), environ 2 200 minutes par mois | 0 |
| Page | GitHub Pages par artefact, URL non listée | 0 |
| État | branche `state` orpheline, un commit forcé par run | 0 |
| Embeddings | OpenAI `text-embedding-3-small` | environ 0,11 USD |
| Briefs et nommage | `gpt-5.4-nano`, 30 clusters par run de brief (4 fois par jour), FR et EN | environ 0,75 USD ; 0 si Groq gratuit |
| Évaluation nocturne | Google News RSS, GDELT | 0 |
| **Total** | | **sous 1 USD** |

Ce qu'on accepte : retards GitHub Actions de 5 à 30 minutes aux heures pleines ; Reddit dégradé tant que l'OAuth n'est pas approuvé ; arXiv et Wikipedia quotidiens ; pas de X.

## 6. Plan d'exécution par lots

### Lot 0 - Collecteur local et premier corpus (1 jour)
- Créer le dépôt `ai-radar` (local d'abord, Git initialisé), copier `text.mjs`, `fetch.mjs`, `llm.mjs`, `parseFeed` ; écrire `config/sources.json` (URL, famille, cadence, parseur) et `config/lexicon.json`.
- `collect.mjs` pour les familles A, D, E, F, G (sans compte). Table `items`, curseurs par source, journal des erreurs par source.
- Tests `node --test` : parseurs sur fixtures HN, HF, OpenRouter, Google News ; dédoublonnage URL ; deux runs consécutifs n'ajoutent aucun doublon.
- **Acceptation :** deux runs à 30 minutes d'écart produisent des items datés de moins d'une heure pour au moins 15 sources ; rapport par source : items, erreurs, latence médiane entre publication et collecte.

### Lot 1 - Regroupement, score, page locale (2 jours)
- `cluster.mjs` (SimHash, embeddings OpenAI, leader clustering), `score.mjs` (entités, z-score, Kleinberg, n_familles, vélocités, statut presse), `render.mjs` (trois vues, JSON, RSS).
- Tests : un même sujet injecté sous trois titres différents tombe dans un cluster ; un terme à 0 puis 2 occurrences ne déclenche pas ; la famille G ne compte pas dans `n_familles`.
- **Acceptation :** sur 48 h de collecte réelle, la page affiche un top 10 dont chaque ligne renvoie à ses items ; Simon juge à la main si 5 des 10 sujets sont réellement « ce dont on parle » ; coût d'embeddings mesuré.

### Lot 2 - Mise en production gratuite (1 jour)
- Dépôt public GitHub, secrets (`OPENAI_API_KEY`, `GITHUB_TOKEN` implicite), workflow cron 30 min, branche `state`, déploiement Pages, badge de dernière exécution sur la page.
- **Acceptation :** 24 h sans intervention, au moins 44 runs réussis sur 48, page à jour à moins de 45 minutes à tout instant ; état repris entre runs (aucun doublon, curseurs conservés) ; coût vérifié sur la facture OpenAI.

### Lot 3 - Sources à compte et briefs (1 jour)
- Bluesky (compte + app password : `searchPosts`, `getTrends`, 50 comptes), Reddit dégradé (et OAuth dès approbation), Mastodon, Kalshi et Manifold.
- `brief.mjs` : nom, « pourquoi maintenant », angle de publication, en FR et EN, pour les 30 premiers clusters, 4 fois par jour ; plafond de coût par jour ; repli Groq.
- **Acceptation :** briefs présents et datés sur la page ; coût LLM journalier affiché ; aucun brief sans au moins deux items sources cliquables.

### Lot 4 - Boucle de validation et calibration (4 semaines, automatique)
- `evaluate.mjs` nocturne : pour chaque cluster détecté à `t0`, compter les articles grand public via Google News RSS à `t0+24h`, `+48h`, `+72h` (et GDELT si disponible) ; `hit` si au moins 3 articles après et 0 avant ; précision@10, rappel inversé sur 10 sujets IA de Google News du jour, avance médiane en heures, score de Brier.
- Section « Hier, nos appels » sur la page. Après 4 semaines : régression logistique sur les composantes, remplacement des poids v1 par les poids appris et calibrés.
- **Acceptation :** rapport hebdomadaire automatique ; cible raisonnable à 4 semaines : précision@10 ≥ 50 %, avance médiane ≥ 3 h sur la presse tech. Un résultat inférieur est publié tel quel avec l'analyse des sources manquantes.

### Lot 5 - Signaux faibles (détaillé en section 10, validé le 22/09/2026 au soir)
Voir la section 10 : nouvelles sources amont à précédents datés, détecteurs de nouveauté, pondération par la précocité des sources, vue séparée à budget fixe, évaluation orientée rappel.

### Lot 6 - Options selon résultats
- GH Archive horaire pour la vélocité d'étoiles exacte ; Cloudflare Workers AI pour des embeddings gratuits ; Wikimedia EventStreams et GDELT continu sur Oracle Always Free si le streaming apporte de l'avance mesurable ; X en 1 à 2 recherches par jour si Simon l'accepte ; alerte optionnelle par mail ou RSS filtré quand un sujet dépasse un score seuil (à la demande, jamais quotidien par défaut).

## 7. Vérification de bout en bout

- Tests unitaires sans réseau : `node --test tests/` (parseurs, dédoublonnage, z-score, Kleinberg, clustering, comptage des familles).
- Test d'intégration local : `node radar.mjs collect && node radar.mjs cluster && node radar.mjs score && node radar.mjs render`, puis ouverture de `public/index.html` ; second passage immédiat : zéro nouvel item, mêmes clusters.
- Production : historique des runs GitHub Actions vert sur 24 h ; `radar.json` horodaté ; page Pages accessible ; branche `state` à un seul commit.
- Qualité : la section « Hier, nos appels » est la seule mesure publiée ; un audit manuel hebdomadaire de Simon sur 10 sujets (juste ou pas, avance réelle) est consigné dans `docs/audit/`.

## 8. Risques et parades

- Sources qui ferment ou changent (Reddit, Google News RSS non documenté) : chaque source est isolée, une panne n'arrête pas le run ; le rapport par source la signale.
- Bruit d'arXiv et de Bluesky : arXiv sert de corpus pour les termes émergents, pas de flux affiché ; Bluesky filtré par mots-clés et comptes curés.
- Dérive de coût : plafonds journaliers d'appels LLM et d'embeddings dans la configuration ; coût réel affiché sur la page.
- Retards GitHub Actions : cadence 30 min et horodatage « mis à jour il y a » visible ; acceptable pour un radar consulté à la demande.
- Croissance du dépôt : items purgés à 14 jours, branche `state` réécrite ; alternative Cloudflare R2 gratuit si la taille dépasse 200 Mo.

## 9. À consigner en mémoire après validation

- Constats d'accès du 22/09/2026 (Reddit 403 anonyme, Bluesky search authentifié, Polymarket bloqué en France, YouTube API 100 recherches par jour, X sans palier gratuit).
- Décisions de Simon : radar mondial IA, page publique non listée, budget sous 15 euros, comptes Bluesky, Reddit, GitHub, Cloudflare acceptés, LLM jamais comme signal.

---

## 10. Lot 5 détaillé - Signaux faibles

### 10.1 Pourquoi et quoi

État au 22/09/2026 au soir : lots 0 à 4 en production, page à https://ssaulay.github.io/ai-radar/, passage planifié toutes les 30 minutes confirmé, briefs profilés, journal de publication, vérification active du statut presse. Le score actuel récompense la confirmation croisée : une famille seule ne rapporte rien, un item isolé est plafonné à 15, le burst exige 5 mentions. C'est voulu pour la précision du top 10, mais cela enterre par construction les signaux faibles. Simon veut les capter.

Quatre recherches de fond ont été menées (méthodes, canaux de fuite code et Hugging Face, canaux d'infrastructure et veilleurs, canaux entreprise et marchés), avec vérification par appels réels. Rapports à archiver dans `ai-radar/docs/research/` au premier commit du lot. Principe retenu de la littérature (Gnip, Petrovic, Ebadi) : rappel élevé et détection rapide impliquent une précision faible ; le module est donc **une vue séparée à budget fixe, évaluée sur le taux de détection précoce et l'avance, jamais un abaissement des seuils du radar principal**.

### 10.2 Nouvelles sources amont, classées par avance mesurée sur des précédents datés

| Rang | Source | Précédents vérifiés | Accès | Coût |
|---|---|---|---|---|
| 1 | **Registre SIRENE** : création d'une filiale française d'un labo | Anthropic France créée le 19/02/2025, bureau annoncé le 07/11/2025 : **261 j** ; OpenAI France 29/08/2024 puis annonce 09/10/2024 : **41 j** | `recherche-entreprises.api.gouv.fr/search?q=<labo>`, déjà utilisé dans `ai_ecosystem` | 0 |
| 2 | **Hugging Face, dépôts créés par les organisations de labos** (`createdAt`) | gpt-oss-safeguard **41 j**, Gemma 3 **11 j**, Magistral 6 j, Llama 4 3 j ; labos chinois : même heure | `/api/models?author=<org>&sort=createdAt&direction=-1` ; signature « `createdAt` antérieur à notre première observation » = passage en public | 0, 500 req / 5 min |
| 3 | **Pull requests des moteurs d'inférence** (transformers, vLLM) ajoutant un modèle non annoncé | Qwen3 **38 j**, GLM-4.5 18 j, DeepSeek V4 **17 j** (diff vLLM mentionnant `DeepseekV4`), Qwen3.5 9 j ; contributeurs les plus précoces : équipes AMD, Intel, NVIDIA et Qwen ; labos américains : jour J, inutile | `repos/{repo}/pulls?state=open&sort=created` ; jeton GitHub d'Actions : 5 000 req/h | 0 |
| 4 | **OpenRouter modèles stealth** | GPT-4.1 **11,9 j**, Grok 4 Fast 13,3 j, GPT-5 7,8 j, GPT-5.1 7 j, GLM-5.3-Flash 5,7 j ; avance en baisse : 1,3 j en sept. 2026 | page `openrouter.ai/stealth` (HTML) puis `/api/v1/models/{id}/endpoints` (`created`) ; absents de `/api/v1/models` | 0 |
| 5 | **Historique Git du fichier de prix LiteLLM** (`model_prices_and_context_window.json`) | `stealth/union-alpha` capté 16 h avant la révélation ; identifiants Bedrock, Azure, Vertex et noms de code non annoncés présents aujourd'hui | `api.github.com/repos/BerriAI/litellm/commits?path=...` toutes les 30 min, diff des clés ajoutées | 0 |
| 6 | **Offres d'emploi** (Ashby, Greenhouse) | robotique OpenAI repérée par les offres en janv. 2025, confirmation publique sept. 2026 : ~20 mois sur la direction ; 11 puis 27 postes robotique en 4 mois | Ashby `api.ashbyhq.com/posting-api/job-board/{openai, mistral.ai, cohere, cursor, perplexity, thinkingmachines}` ; Greenhouse `boards-api.greenhouse.io/v1/boards/{anthropic, xai, scaleai}/jobs` ; stocker les instantanés dès J0 | 0 |
| 7 | **Dépôts réglementaires SEC Form D** via les SPV nommés d'après la cible | Thinking Machines 27/06/2025, annonce 15/07 : **18 j** ; xAI 6 Md dépôt 05/12/2024, communiqué 24/12 ; OpenAI et Anthropic ne déposent pas en propre | `efts.sec.gov/LATEST/search-index?q="<labo>"&forms=D`, User-Agent avec e-mail | 0 |
| 8 | **Sitemaps et changelogs officiels** | `openai.com/sitemap.xml` : 42 sous-sitemaps, `lastmod` à la milliseconde, billets vus à la minute ; `anthropic.com/sitemap.xml` : seule l'apparition d'URL compte ; changelogs Markdown bruts `platform.openai.com/docs/changelog.md` et `ai.google.dev/gemini-api/docs/changelog.md.txt` ; `cloud.google.com/feeds/vertex-ai-release-notes.xml` ; `status.{openai,anthropic}.com/api/v2/components.json` (composant Claude Cowork créé 8 j avant la GA) | GET simples, robots.txt d'openai.com autorise | 0 |
| 9 | **Annonces de conférences et keynotes** | « Code with Claude » annoncée le 03/04/2025 pour le 22/05, jour du lancement de Claude 4 : **49 j** sur la fenêtre | déjà couvert par les blogs officiels ; règle : une date d'événement = fenêtre de lancement | 0 |
| 10 | **Marchés de prédiction** | Gemini 3 : marché ouvert 5 j avant ; GPT-5 : 3 j ; l'aval de l'arène et d'OpenRouter, pas l'amont | Polymarket Gamma API fonctionne depuis les runners GitHub (bloqué en France) ; la **création** d'un marché « quand sortira X » est l'alerte ; Kalshi et Manifold déjà branchés | 0 |
| 11 | **Forums et communautés** | forums Discourse `latest.json` (Perplexity, Google AI dev en plus des trois actuels) ; widgets Discord publics d'OpenAI et Hugging Face : liste des salons, dont des salons de préproduction | GET simples | 0 |
| 12 | **Précurseurs sur Bluesky** | Tibor Blaho (`btibor91.blaho.me`) et TestingCatalog (pont Bluesky) : Operator 3 j avant, Atlas 2 mois avant par une condition de feature flag ; liste élargie de chercheurs et journalistes en cours de vérification (rapport précurseurs) | `getAuthorFeed`, gratuit | 0 |
| 13 | **Federal Register** | consultations et deadlines réglementaires IA | `federalregister.gov/api/v1/documents.json` | 0 |

Résultats négatifs à assumer, vérifiés : LMArena et arena.ai renvoient 403 partout, observable seulement par veille sociale ; aucun précédent documenté de sous-domaine repéré par les logs de certificats avant une annonce IA (canal d'infrastructure, pas de produit ; CertSpotter gardé en option basse) ; Wikipedia en retard de 1 à 2 jours sur la presse, confirmation seulement ; notes de version iOS génériques (l'horodatage de build reste utile) ; OpenReview, Semantic Scholar, Metaculus, OpenCorporates, Lever fermés sans clé ou sans intérêt ; flux d'événements GitHub des labos saturé de stars et forks, remplacé par la liste des dépôts triés par création.

Écarté pour raisons de conditions d'utilisation : désassemblage d'APK. Option assumée, désactivée par défaut : diff des chaînes des bundles JavaScript publics des applications web (canal le plus productif des veilleurs, mais clauses d'ingénierie inverse).

### 10.3 Détecteurs (module `src/analyze/weak.mjs`, aucun LLM)

À chaque passage, sur les nouveaux items :
- **D1 nouveauté** : `1 - max cos(e, corpus 30 jours)` ; candidat au-dessus du 97e percentile glissant de 14 jours. Recherche exacte, 60 000 produits scalaires au plus par item, pas de LSH.
- **D2 terme jamais vu** : nom propre absent de `term_daily` sur 30 jours ; test d'Erlang sur les 3 dernières mentions (`p = P(Poisson(λ_sup·t) ≥ 3)`, `λ_sup = 3 / nb de jours observés`, seuil 10⁻⁴), ou C-test « 0 puis 2 » ; entrée directe si 2 familles distinctes en 24 h avec crédibilité moyenne ≥ 0,5. Corrige le « 0 puis 2 ne déclenche rien » actuel.
- **D3 paire d'entités inédite** entre entités connues (≥ 5 mentions / 30 jours) : `score = surprise_fréquentielle × 1/(1 + Adamic-Adar) × crédibilité` ; les paires prédites par les voisins communs ne sont pas des signaux.
- **D4 vocabulaire nouveau pour une source** à crédibilité ≥ 0,6 : terme absent des 90 jours de cette source.
- **D5 item isolé d'une source précoce** : `crédibilité × précocité ≥ 0,6`, où la précocité est l'avance médiane historique de la source sur les sujets confirmés.
- **D6 HN nouveautés** : `points / (âge_h + 2)^1,8` sur les items de moins de 2 h, seuil au 95e percentile.
- **D7 événements de catalogue** issus des sources 10.2 : nouveau modèle stealth, nouveau dépôt HF ou GitHub d'un labo, PR d'inférence citant un nom de modèle inconnu du lexique, nouvelle clé LiteLLM, nouvelle URL de sitemap, nouveau composant de statut, nouvelle entité SIRENE, grappe d'offres d'emploi sur un mot-clé, nouveau marché « quand sortira X », dépôt Form D. Chacun entre avec une raison lisible.

Une fois par jour :
- **Carte fréquence contre croissance** (Yoon, Ebadi) sur 14 jours de bins journaliers, avec le **nombre de sources distinctes** comme axe de diffusion ; quadrant fréquence basse et croissance forte sur les deux cartes = signal faible.
- **Popularité avec décroissance** des clusters (BERTrend, `λ = 0,01`) et classement par percentiles glissants : faible = P10 à P50 avec pente positive.
- **Statistiques par source** : avance médiane et taux de confirmation sur les sujets confirmés, crédibilité bayésienne `(a + confirmés) / (a + b + signalés)` avec priors par famille (labos et pages release 0,7 ; HN nouveautés 0,5 ; arXiv 0,4 ; agrégateurs et newsletters 0,3 ; communautés 0,35).

Score : `surprise_bits × crédibilité × (0,5 + précocité) × diversité_familles`. Budget : 15 à 20 signaux affichés par jour, dédoublonnés par sujet et par paire, refroidissement de 72 h.

### 10.4 Tables et fichiers

Nouvelles tables : `term_daily`, `term_last_ts`, `source_vocab`, `entity_mentions`, `entity_pairs`, `source_stats`, `weak_signals`, `weak_signal_outcomes`, `cluster_popularity`, `catalog_snapshots` (état précédent des catalogues pour les diffs : OpenRouter stealth, LiteLLM clés, HF par org, GitHub dépôts par org, sitemaps, composants de statut, SIRENE par labo, offres par board, marchés).

Fichiers : `src/collect/catalog.mjs` (sources 10.2 à diff), `src/analyze/weak.mjs` (détecteurs), `src/analyze/sources.mjs` (statistiques et crédibilité), `config/labs.json` (organisations à surveiller : slugs HF, GitHub, Ashby, Greenhouse, noms légaux SIRENE, tickers), `config/precursors.json` (comptes et flux vérifiés issus du rapport précurseurs), onglet « Signaux faibles » dans `render.mjs`, tests dans `tests/weak.test.mjs`.

### 10.5 Ordre d'exécution et acceptation

- **5a - Catalogues à fuite (1 jour)** : OpenRouter stealth, LiteLLM, HF par labo, GitHub dépôts et PR d'inférence, sitemaps et changelogs, composants de statut. Acceptation : chaque diff produit des événements datés dans `weak_signals` ; rejouer le run sur le même état ne produit rien ; un test sur fixtures reproduit les précédents (une PR « add Qwen3 » citant un nom inconnu du lexique est détectée).
- **5b - Signaux entreprise (½ jour)** : SIRENE par nom de labo, Ashby et Greenhouse avec instantanés, EDGAR Form D, création de marchés Polymarket, Discourse et widgets Discord. Acceptation : première passe sans erreur, événements avec source et lien ; Polymarket testé depuis le runner uniquement.
- **5c - Détecteurs et crédibilité (1 jour)** : D1 à D6, tables de termes et de paires, statistiques par source, score et budget. Acceptation : tests sur fixtures (0 puis 2 sans indépendance ne sort pas ; 2 familles en 24 h sort ; paire prédite par voisins communs ne sort pas) ; `node radar.mjs weak` produit au plus 20 signaux avec raison.
- **5d - Mode fantôme puis affichage (2 semaines automatiques)** : calcul et étiquetage à 72 h sans affichage ; étiquette « confirmé » si le sujet atteint ensuite le top 20 du radar, deux familles ou la presse ; publication du taux de détection précoce, de l'avance médiane et du taux de confirmation par détecteur et par source ; puis onglet « Signaux faibles » avec ces taux affichés à côté de chaque ligne.
- **Précurseurs** : intégration de `config/precursors.json` dès réception du rapport, en famille C et F.

Coût additionnel : nul en argent (tout est API publique ou jeton GitHub d'Actions), 3 à 5 minutes de plus par passage. Risque principal : le bruit ; parade : budget fixe, mode fantôme, taux de confirmation affichés, et Simon juge la vue sur le taux de détection précoce, pas sur sa précision brute.

### 10.6 Précurseurs : comptes, flux et mesure de leur précocité

Rapport précurseurs rendu le 22/09/2026, handles vérifiés par appel à l'API Bluesky (`getProfile`), flux vérifiés par GET.

- **Bluesky** : environ 170 comptes vérifiés à suivre par `getAuthorFeed` (chercheurs, ingénieurs de labos, journalistes spécialisés, veilleurs, francophones), dont Simon Willison, Nathan Lambert, Sebastian Raschka, Ethan Mollick, l'équipe Hugging Face (Delangue, Wolf, Chaumond, Tunstall, von Werra, Ben Allal, Noyan, Srivastav), Jeff Dean, Noam Brown, Chris Olah, Boris Cherny, les journalistes de The Verge, WIRED, Bloomberg, The Information, Axios, 404 Media, les critiques (Bender, Mitchell, Marcus, Zitron), les francophones (LeCun, Bengio, Varoquaux, Grisel, Langlais, Louf, Mensch, Kyutai, Marc Rees, Colombain, Nitot), TestingCatalog et ThursdAI. Actuellement 18 comptes suivis : passage à environ 170, en famille C, avec `limit=10` par compte et une cadence horaire (170 requêtes par heure, sous la limite Bluesky).
- **Absents de Bluesky**, donc inaccessibles sans X : Tibor Blaho hormis son pont `btibor91.blaho.me` s'il est actif, Jimmy Apples et les comptes de rumeurs, Kyle Wiggers, Alex Heath, Guillaume Lample, Timothée Lacroix, plusieurs voix françaises présentes seulement sur LinkedIn et X. À noter dans la couverture affichée.
- **Newsletters et blogs** : environ 80 flux vérifiés, dont une trentaine absents du radar aujourd'hui (Ahead of AI, AI Supremacy, SemiAnalysis, Stratechery, Platformer, Big Technology, Exponential View, Understanding AI, Zvi, Alignment Forum, Karpathy, Lil'Log, Chip Huyen, Eugene Yan, Hamel Husain, ThursdAI, Transformer, Hyperdimensional, ChinaTalk, ChinAI, Interconnected, Where's Your Ed At, Sources, Spyglass, Newcomer, Pragmatic Engineer, The Gradient, BAIR, EleutherAI, METR, Ollama, TestingCatalog, The Decoder, Ezratty, Cavazza). Sans flux, vérifié : The Batch, Anthropic, Kyutai, Dust, Pleias, Meta AI, xAI, Cohere, Qwen, DeepSeek, Contexte, L'Informé.
- **Presse et communautés supplémentaires vérifiées** : presse FR élargie (Next, Usine Digitale, Siècle Digital, ZDNet FR, Journal du Net, Le Monde Informatique, Clubic, 01net, Les Numériques, Silicon, Figaro high-tech, BFM Tech, France 24 éco-tech, The Conversation FR), presse chinoise (QbitAI, AI Era, Leiphone, IT之家, InfoQ CN) pour les modèles chinois, forums annonces (OpenAI, Cursor), subreddits de niche à haute précocité (r/mlscaling curé par Gwern, r/DeepSeek), 30 podcasts et 35 chaînes YouTube par RSS, 19 comptes Mastodon par RSS.
- **Mesure empirique de précocité** (à adapter à SQLite, sans fonctions fenêtre avancées) : par source et par sujet confirmé, `lead_h = confirmation − première observation de la source`, où la confirmation est le plus tôt entre reprise par une source de référence, HN ≥ 50 points et 3 sources non-référence en 24 h ; par source : nombre de sujets, taux de confirmation avec borne basse de Wilson, avance médiane, part des fois où la source est dans les 3 premières. Score précurseur `= précision_basse × ln(1 + avance_médiane) × (0,5 + part_top3)`. Un item isolé d'une source est affiché comme signal faible si `n_confirmés ≥ 8`, `précision_basse ≥ 0,4` et `avance_médiane ≥ 4 h`. Démarrage à froid : prior Beta(6, 2) pour les sources de la liste vérifiée, Beta(2, 2) sinon. Pièges notés : utiliser la première observation et non la date de publication, exclure les reposts, maintenir une table d'alias de noms de code (Strawberry vers o1).
- Fichier `config/precursors.json` à créer avec les listes vérifiées (`bsky_authors`, `newsletters`, `press_extra`, `podcasts`, `youtube`, `mastodon_rss`, `discord_widgets`), en séparant les comptes « réservés mais vides » signalés par le rapport, à exclure.

### 10.7 Ce que ce lot ne fera pas, et pourquoi

- Pas de désassemblage d'APK ni de lecture des messages Discord ou Telegram par compte utilisateur : conditions d'utilisation. Les aperçus publics Telegram `t.me/s` restent hors périmètre par défaut.
- Pas de diff des bundles JavaScript des applications web par défaut : canal le plus productif des veilleurs, mais clauses d'ingénierie inverse ; laissé en option explicite si Simon l'assume.
- Pas de LMArena : fermé programmatiquement ; couvert indirectement par les précurseurs.
- Pas de Wikipedia en alerte : retard mesuré de 1 à 2 jours ; reste en confirmation.
- Pas de baisse des seuils du radar principal : la vue signaux faibles est séparée et jugée sur le rappel précoce.

## 11. Passation à un nouvel agent (écrite le 22/09/2026 au soir, contexte du chat précédent saturé)

### 11.1 État exact au moment de la passation

- Dépôt : `/Users/simon.saulay/Documents/ChatGPT/ai-radar` (Git, branche `main`, distant `https://github.com/ssaulay/ai-radar`, public). Tout est commité et poussé. `.env` local (ignoré) contient `OPENAI_API_KEY`, `BSKY_HANDLE`, `BSKY_APP_PASSWORD`. Secrets GitHub identiques.
- Production : workflow `.github/workflows/radar.yml`, cron `7,37 * * * *`, premier passage planifié réussi à 15:39 UTC le 22/09 (13 min). État sur la branche orpheline `state` (`radar.sqlite`, ~33 Mo, un seul commit réécrit). Page : https://ssaulay.github.io/ai-radar/ (onglets Radar, Briefs, Flux 24 h, Nos appels, Publié, Couverture).
- Code : `radar.mjs` (CLI : collect, cluster, score, render, analyze, run, status, purge, evaluate, recluster, mark, outcome), `src/core/{store,http,text,embed,llm,env}.mjs`, `src/collect/{collect,parsers}.mjs`, `src/analyze/{relevance,cluster,score,brief,presscheck,evaluate,publish}.mjs`, `src/render/render.mjs`, `config/{sources,lexicon,profile}.json`, `tests/{collect,analyze}.test.mjs` (13 tests verts), `README.md`, `docs/PLAN.md` (copie ancienne de ce plan, à remplacer), `docs/research/` (deux synthèses du 22/09).
- Lots 0 à 4 livrés. Lot 5 (section 10) validé sur le principe par Simon, non commencé. `ai_ecosystem` (autre dépôt, privé, local) reste indépendant ; son `.env` contient des clés Groq et X à ne pas réutiliser ici.
- Mémoire persistante du projet : `/Users/simon.saulay/.claude/projects/-Users-simon-saulay-Documents-ChatGPT-ai-ecosystem/memory/` (fichiers `ai-radar-*.md`, `MEMORY.md`). Elle n'est chargée automatiquement que si la session s'ouvre dans `ai_ecosystem` ; la lire explicitement sinon.

### 11.2 Règles non négociables héritées

1. Aucun score, compte de lignes ou sortie de LLM n'est présenté comme une vérification. Le LLM regroupe, nomme, résume ; il ne décide jamais qu'un sujet monte.
2. Le statut presse vient d'une vérification active dans Google News avec la requête affichée ; jamais déduit de la seule collecte.
3. Pas de scraping de plateformes qui l'interdisent (X, LinkedIn, Telegram, APK, LMArena). API publiques, flux RSS, pages prévues pour les machines seulement. Options grises désactivées par défaut (section 10.7).
4. Budget total sous 2 USD par mois ; coûts affichés sur la page. Pas de tâche récurrente autre que le cron du radar.
5. La vue signaux faibles est séparée, à budget fixe, en mode fantôme deux semaines, jugée sur le taux de détection précoce ; on ne baisse pas les seuils du radar principal.
6. Chaque lot se termine par des tests verts, un run réel, un commit poussé, et un rapport honnête de ce qui n'a pas marché. Simon audite le rapport, il n'est pas le banc de test.
7. Français, pas de tirets cadratins, réponses courtes et concrètes.

### 11.3 Premiers gestes du nouvel agent

1. Lire ce fichier en entier, puis `ai-radar/README.md`, `radar.mjs`, `src/analyze/score.mjs`, `src/collect/collect.mjs`, `config/sources.json`.
2. Copier ce plan dans `ai-radar/docs/PLAN.md` (remplacer l'ancien) et commiter.
3. Vérifier l'état : `node --test tests/*.test.mjs`, `gh run list --repo ssaulay/ai-radar --limit 5`, ouvrir la page, `node radar.mjs status`.
4. Dérouler le lot 5 dans l'ordre 5a, 5b, 5c, 5d (section 10.5), un sous-lot par commit, avec pour chacun : tests sur fixtures, run réel local, `git push`, vérification du passage GitHub Actions suivant, compte rendu à Simon.
5. Créer `config/labs.json` et `config/precursors.json` à partir des sections 10.2 et 10.6 ; revérifier par appel les handles et flux avant de les activer (les listes datent du 22/09/2026).
6. Consigner en mémoire chaque décision de Simon et chaque constat d'accès (fichier `ai-radar-*.md` dans le dossier de mémoire cité en 11.1, une ligne dans `MEMORY.md`).

