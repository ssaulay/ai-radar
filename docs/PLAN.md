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

### Lot 5 - Options selon résultats (à décider après le lot 4)
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
