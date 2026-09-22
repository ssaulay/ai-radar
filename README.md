# ai-radar

Radar gratuit des sujets IA qui émergent, pour repérer avant la presse ce qui fera l'actualité dans les 24 à 72 heures. Collecte multi-sources publiques, détection de burst sans LLM, page statique. Plan complet dans `docs/PLAN.md`.

## Principes

- Un LLM ne décide jamais qu'un sujet monte : il regroupe, nomme et résume. Le score est calculé à partir de comptes et de vélocités observables, et sa décomposition est affichée.
- Les sources de presse (famille G) ne comptent pas dans l'anticipation ; elles servent à dater le moment où un sujet est repris.
- Chaque sujet renvoie à ses items sources. Une absence d'observation n'est pas une absence d'activité : la couverture est affichée.
- Aucun scraping de plateformes qui l'interdisent (X, LinkedIn, Telegram). Uniquement API publiques, flux RSS et pages prévues pour les machines.

## Lancer

```bash
node radar.mjs collect            # collecte les sources dues (cadence par source dans config/sources.json)
node radar.mjs collect --force    # toutes les sources, tout de suite
node radar.mjs catalog            # catalogues à fuite (lots 5a et 5b), événements dans weak_signals
node radar.mjs weak               # détecteurs de signaux faibles (lot 5c), sélection du jour, métriques d'étiquetage (5d)
node radar.mjs status             # items par famille et par source, dernier état de chaque source
node radar.mjs purge --days 14    # supprime les items anciens
node --test tests/*.test.mjs
```

Clés optionnelles dans `.env` (voir `.env.example`) : `GITHUB_TOKEN` (30 recherches par minute au lieu de 10), `BSKY_JWT` (recherche Bluesky), `OPENAI_API_KEY` (embeddings et briefs, lots suivants).

## Sources

`config/sources.json` : 70 sources en 8 familles (agrégateurs tech, Reddit, Bluesky et Mastodon, recherche, code et modèles, annonces officielles et blogs experts, presse EN et FR, marchés de prédiction). Chaque source a un type de parseur, une cadence et, si besoin, un délai par hôte. `config/lexicon.json` : entités IA suivies pour la détection de burst.

## Pipeline

```
collect -> cluster (pertinence IA, embeddings OpenAI 512 d, leader clustering ancré) -> score (familles, burst, vélocités, officiel) -> render (public/index.html, radar.json, radar.xml)
node radar.mjs run          # tout enchaîner puis purger ; c'est ce que fait le workflow
node radar.mjs analyze      # cluster + score + render sans collecte
node radar.mjs recluster    # efface les sujets (garde les embeddings) pour recalibrer
```

## Profil et boucle de publication

`config/profile.json` décrit le créateur (positionnement, audiences FR et EN, angles préférés, à éviter). Les briefs l'utilisent pour proposer un angle, deux accroches, une adéquation HIGH/MEDIUM/LOW, une différenciation par rapport à la presse et un risque. Le profil n'influence jamais le score.

```bash
node radar.mjs mark --cluster 9182 --url https://www.linkedin.com/posts/... --lang fr     # j'ai publié sur ce sujet
node radar.mjs outcome --url https://www.linkedin.com/posts/... --impressions 4200 --reactions 61 --comments 9
```

L'onglet « Publié » de la page liste les posts avec le score et le statut presse au moment de la publication, l'avance sur la presse, et les résultats saisis. À partir de 5 posts mesurés, il affiche des médianes par statut, langue et plateforme. Inspiré de la couche d'attribution du projet Easel (ZJU-REAL), sans publication automatique.

## Signaux faibles (lot 5, mode fantôme)

Le radar principal récompense la confirmation croisée et enterre par construction les signaux isolés. Le lot 5 les capte dans une vue séparée, à budget fixe, jugée sur le taux de détection précoce, sans baisser les seuils du radar. Pendant deux semaines rien n'est affiché : les signaux s'accumulent dans la table `weak_signals` et seront étiquetés à 72 h avant toute publication.

**5a, catalogues à fuite** (`src/collect/catalog.mjs`, détecteur D7) : on ne lit pas des articles mais des états, et l'apparition d'une clé entre deux passages est l'événement, daté et expliqué. Catalogues (`config/catalogs.json`, organisations dans `config/labs.json`, slugs vérifiés par appel) : modèles stealth d'OpenRouter, clés du fichier de prix LiteLLM, dépôts Hugging Face et GitHub de 34 laboratoires, pull requests d'ajout de modèle dans transformers, vLLM, SGLang et llama.cpp, sitemaps d'OpenAI, Anthropic, DeepMind, Mistral et Cursor, changelogs Markdown des API OpenAI, Gemini et Claude, composants des pages de statut OpenAI et Anthropic. Tout est API publique, fichier prévu pour les machines ou page autorisée par robots.txt ; aucun LLM ; coût nul (environ 85 requêtes et 45 s par passage).

```bash
node radar.mjs catalog            # catalogues dus (cadence par catalogue)
node radar.mjs catalog --force    # tous, tout de suite ; utile pour vérifier qu'un rejeu ne produit rien
node radar.mjs catalog --only pulls_vllm,status_anthropic
```

**5b, signaux entreprise** (mêmes mécanique et tables, 42 catalogues de plus) : registre SIRENE par nom de laboratoire (création d'une entité française, personnes physiques exclues, aucun dirigeant personne physique conservé ; précédents Anthropic France 261 jours avant l'annonce du bureau, OpenAI France 41 jours), offres d'emploi Ashby (OpenAI, Mistral, Cohere, Cursor, Perplexity, Thinking Machines, ElevenLabs) et Greenhouse (Anthropic, xAI, Scale AI) historisées dans `job_postings` dès le premier passage avec un événement groupé par board et par passage et un événement par nouvelle équipe, dépôts SEC Form D par recherche plein texte du nom exact (SPV nommés d'après la cible ; précédent Thinking Machines 18 jours), catégories des forums Discourse (OpenAI, Hugging Face, Cursor, Perplexity, Google AI), salons visibles des widgets Discord d'OpenAI et Hugging Face, et création de marchés Polymarket sur l'IA (API Gamma bloquée en France : lue depuis le runner GitHub seulement, sautée en local). Les forums Perplexity et Google AI entrent aussi comme sources RSS de la famille F.

Règles : le premier passage amorce l'instantané (`catalog_snapshots`) sans événement, sauf pour les entrées qui portent leur propre horodatage et datent de moins de 48 h ; rejouer le même état ne produit rien, la clé (détecteur, catalogue, clé) est unique ; un dépôt dont la date de création est très antérieure à sa première observation est signalé comme « rendu visible bien après sa création » (passage privé vers public, le précédent Gemma 3 : 11 jours d'avance). Les PR d'inférence sont retenues si le titre ajoute un modèle et cite un nom propre ; le nom est confronté au lexique (inconnu = plus intéressant). `catalog` fait partie de `run` et une panne de catalogue n'arrête jamais le passage.

**5c, détecteurs et crédibilité** (`src/analyze/weak.mjs`, aucun LLM, `node radar.mjs weak`, aussi dans `run` après le score) : D1 nouveauté sémantique (1 moins la similarité maximale au corpus, au-dessus du 97e percentile glissant, 200 valeurs minimum), D2 terme jamais vu (nom propre apparu depuis moins de 48 h : test d'Erlang sur les trois dernières mentions, seuil 10⁻⁴, ou reprise par deux familles indépendantes en 24 h avec crédibilité moyenne ≥ 0,5 ; inactif tant que le corpus n'a pas 7 jours, car « 0 puis 2 » exige un passé de zéros), D3 paire d'entités inédite entre entités connues, non prédite par les voisins communs (Adamic-Adar), D4 vocabulaire nouveau pour une source crédible (≥ 0,6, 7 jours observés), D5 item isolé d'une source précoce (crédibilité × précocité ≥ 0,6, actif quand les statistiques par source existent), D6 nouveautés Hacker News (points / (âge + 2)^1,8 au-dessus du 95e percentile, 200 valeurs et 10 points minimum), D7 événements de catalogue. Une fois par jour : carte fréquence contre croissance sur 14 jours (D8, requiert 7 jours de termes) et popularité des sujets avec décroissance (D9, requiert 30 sujets). Les titres en Title Case (arXiv) ne fournissent que des jetons de type nom de modèle. Score = bits de surprise × crédibilité de la source (priors par famille, puis bayésien) × (0,5 + précocité) × familles distinctes. Budget : 20 signaux par jour, dédoublonnés par sujet et par entité, refroidissement 72 h. Tables : `term_daily`, `term_last_ts`, `source_vocab`, `entity_mentions`, `entity_pairs`, `source_stats`, `weak_values`, `weak_selection`.

**5d, mode fantôme puis affichage** : chaque signal est étiqueté 72 h après sa détection (`weak_signal_outcomes`) : confirmé si son sujet atteint ensuite le top 20 du radar, gagne une deuxième famille, ou est repris par la presse (vérification Google News du radar) ; sinon non confirmé. Les taux de confirmation et de détection précoce et l'avance médiane par détecteur et par source sont calculés (`weakMetrics`) et publiés en chiffres seulement dans `radar.json` (`weak_signals`), sans aucune ligne de signal, pendant deux semaines à partir du 22/09/2026. L'onglet « Signaux faibles » n'apparaîtra qu'ensuite, avec ces taux à côté de chaque ligne. La crédibilité par source se met à jour à partir des étiquettes : (a + confirmés) / (a + b + signalés) avec un prior Beta de force 8 par famille.

## Production

`.github/workflows/radar.yml` : GitHub Actions toutes les 30 minutes (`7,37 * * * *`), tests puis `run`, état sauvegardé sur la branche orpheline `state` (un seul commit, réécrit à chaque passage), page déployée sur GitHub Pages par artefact. Secrets attendus : `OPENAI_API_KEY` (embeddings, briefs), optionnels `BSKY_JWT`. `GITHUB_TOKEN` est fourni par Actions. Coût mesuré : environ 0,003 USD d'embeddings par analyse complète du corpus initial ; en régime de croisière quelques centimes par jour.

## État

Base SQLite `state/radar.sqlite` (ignorée par Git sur `main` ; publiée sur la branche `state`). Items conservés 14 jours, embeddings 4 jours, clusters et scores 72 h d'activité.

## Ce que le score veut dire

`score = 25·familles + 20·burst + 15·HN + 10·GitHub + 10·HF + 10·officiel + 10·social`, multiplié par un facteur de fraîcheur (1 dans les 6 h suivant la dernière activité, 0,4 à 48 h). Un item isolé sans vélocité ni annonce majeure est plafonné à 15. Les composantes sont visibles au survol du score sur la page. Le statut presse est indépendant : `ANTICIPATION` (aucun article), `CONFIRMED` (au moins un article), `PRESS_ONLY`.

Le radar mesure ce que l'on écoute. Sa capacité réelle d'anticipation ne sera connue qu'après la boucle de validation du lot 4 (précision@10 et avance médiane sur la presse, publiées sur la page).
