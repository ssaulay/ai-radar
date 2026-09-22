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

## Production

`.github/workflows/radar.yml` : GitHub Actions toutes les 30 minutes (`7,37 * * * *`), tests puis `run`, état sauvegardé sur la branche orpheline `state` (un seul commit, réécrit à chaque passage), page déployée sur GitHub Pages par artefact. Secrets attendus : `OPENAI_API_KEY` (embeddings, briefs), optionnels `BSKY_JWT`. `GITHUB_TOKEN` est fourni par Actions. Coût mesuré : environ 0,003 USD d'embeddings par analyse complète du corpus initial ; en régime de croisière quelques centimes par jour.

## État

Base SQLite `state/radar.sqlite` (ignorée par Git sur `main` ; publiée sur la branche `state`). Items conservés 14 jours, embeddings 4 jours, clusters et scores 72 h d'activité.

## Ce que le score veut dire

`score = 25·familles + 20·burst + 15·HN + 10·GitHub + 10·HF + 10·officiel + 10·social`, multiplié par un facteur de fraîcheur (1 dans les 6 h suivant la dernière activité, 0,4 à 48 h). Un item isolé sans vélocité ni annonce majeure est plafonné à 15. Les composantes sont visibles au survol du score sur la page. Le statut presse est indépendant : `ANTICIPATION` (aucun article), `CONFIRMED` (au moins un article), `PRESS_ONLY`.

Le radar mesure ce que l'on écoute. Sa capacité réelle d'anticipation ne sera connue qu'après la boucle de validation du lot 4 (précision@10 et avance médiane sur la presse, publiées sur la page).
