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

## État

Base SQLite `state/radar.sqlite` (ignorée par Git ; publiée sur la branche `state` en production). Items conservés 14 jours.
