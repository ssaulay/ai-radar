# Catalogues à fuite : constats d'accès vérifiés le 22/09/2026 (sous-lot 5a)

Vérifications par appels réels (curl, jeton GitHub personnel pour les appels locaux) faites avant d'écrire `src/collect/catalog.mjs`. Les quatre rapports de recherche cités en section 10.1 du plan n'ont pas été transmis au moment de la passation : la section 10.2 du plan (`docs/PLAN.md`) reste la seule archive de leurs précédents datés ; ce document consigne ce qui a été revérifié ici.

## Accès confirmés

| Catalogue | Accès | Constat |
|---|---|---|
| OpenRouter stealth | `GET https://openrouter.ai/stealth` (HTML, 250 Ko) ; `robots.txt` : `Allow: /`, `Disallow: /seo/` | La page liste les modèles anonymes par liens `href="/stealth/<slug>"` (le 22/09 : `ox-alpha`, `union-alpha`), absents de `/api/v1/models`. `GET /api/v1/models/stealth/<slug>/endpoints` renvoie `data.created` (Ox Alpha : 2026-08-20T20:04Z), `name`, `description`, `endpoints[]`. Les autres formes d'identifiant (`openrouter/<slug>`, `<slug>`) renvoient 404. |
| LiteLLM prix | `GET api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1` puis `raw.githubusercontent.com/BerriAI/litellm/<sha>/...` | Fichier de 2,9 Mo, 4 500 clés. Commits très fréquents (« sync OpenRouter prices » toutes les quelques heures) : on ne relit le fichier que si le sha a changé. Les clés `openrouter/` sont ignorées (déjà couvertes par la source E). Présent le 22/09 : `anthropic.claude-mythos-preview` (identifiant Bedrock). |
| Hugging Face par organisation | `GET huggingface.co/api/models?author=<org>&sort=createdAt&direction=-1&limit=20` | Champs : `id`, `createdAt`, `private`, `likes`, `downloads`, `pipeline_tag`, `tags`. 31 slugs vérifiés (200, non vides). `anthropic` : 200 mais vide (pas d'organisation HF publique). `Kimi` : vide, utiliser `moonshotai`. |
| GitHub par organisation | `GET api.github.com/orgs/<org>/repos?sort=created&direction=desc&per_page=20&type=public` | 30 slugs vérifiés. `LiquidAI` : 404. Limite : 60 req/h sans jeton, le `GITHUB_TOKEN` d'Actions suffit largement (une trentaine d'appels par heure). Forks exclus. |
| PR des moteurs d'inférence | `GET api.github.com/repos/<repo>/pulls?state=open&sort=created&direction=desc&per_page=50` | vLLM préfixe ses titres par `[Model]`, `[Bugfix][Model]`, etc. ; transformers sans convention stable (labels vides sur l'échantillon, PR de bots `sergereview[bot]` à exclure) ; SGLang `[Prefill Graph/Models] Support ...` ; llama.cpp `model : support Gemma4 DSpark draft backbone`. Le détecteur exige un mot « model » ou « architecture », un verbe d'ajout et au moins un nom propre non générique. |
| Sitemaps | `GET https://openai.com/sitemap.xml` (index de 42 sous-sitemaps) | `lastmod` régénéré à chaque lecture (ex. 16:46:31 puis 16:41:24 pour des billets anciens) : inutilisable, seule l'apparition d'URL compte. Tailles : `page/` 3,2 Mo et `company/` 1,3 Mo (exclus), `product/` 1,2 Mo (toutes les 60 min), `release/` 450 Ko (78 billets `/index/`), `research/` 450 Ko, `publication/` 560 Ko, `engineering/` 200 Ko, `milestone/` 87 Ko, `api/` 75 Ko, `chatgpt/` 23 Ko, `sora/` 20 Ko. Le poids vient des `xhtml:link` alternates (40 langues). `robots.txt` d'openai.com : seul `/microsoft-for-startups/` interdit. |
| | `GET https://www.anthropic.com/sitemap.xml` | 535 URL, 70 Ko, un seul fichier, `lastmod` de la racine à l'heure courante. |
| | `deepmind.google/sitemap.xml` (734 URL, 86 Ko, `lastmod` au jour), `mistral.ai/sitemap-0.xml` (486 URL, 190 Ko, via l'index `sitemap.xml`), `cursor.com/sitemap.xml` (192 URL, 31 Ko) | OK. `x.ai/sitemap.xml` : 403. `perplexity.ai/sitemap.xml` : index de 7 sous-sitemaps marketing, non retenu. `huggingface.co/sitemap.xml` : index de sous-sitemaps énormes, non retenu. |
| Changelogs Markdown | `platform.openai.com/docs/changelog.md` (69 Ko, `text/markdown`) | Structure `## September, 2026` / `### Sep 15` / paragraphe « Feature » / paragraphe de texte. Les pages `.md` sont documentées comme prévues pour les machines (« append .md to the page URL »). |
| | `ai.google.dev/gemini-api/docs/changelog.md.txt` (57 Ko) | `## September 18, 2026` puis puces `- **Titre**: texte` avec lignes de continuation indentées. `robots.txt` : tout autorisé. |
| | `platform.claude.com/docs/en/release-notes/overview.md` (110 Ko ; `docs.claude.com/...` et `docs.anthropic.com/...` redirigent ici) | En-tête YAML, bloc `<Tip>` à ignorer, `### September 22, 2026` puis puces `* ...`. `robots.txt` : seul `/api/` interdit. Le 22/09 la première entrée annonçait Claude Opus 5.5 le jour même. |
| Composants de statut | `status.openai.com/api/v2/components.json` (34 composants, les plus récents « Sites » et « ChatGPT Work » créés le 09/07/2026) ; `status.anthropic.com/api/v2/components.json` (6 composants, « Claude Cowork » créé le 01/04/2026 ; `status.claude.com` renvoie la même page) | API Statuspage, prévue pour les machines. |

## Résultats négatifs

- `status.mistral.ai` et `status.x.ai` : 403 (protection anti-robot). `status.gemini.google` : hôte inexistant.
- `cloud.google.com/feeds/vertex-ai-release-notes.xml` répond mais sa dernière entrée date du 16/03/2026 : flux figé, non ajouté.
- `x.ai/sitemap.xml` : 403.
- Organisation Hugging Face `anthropic` vide ; organisation GitHub `LiquidAI` inexistante.

## Premier passage réel (local, 22/09/2026 vers 17:10 UTC)

81 catalogues lus, 0 erreur, 84 requêtes HTTP, 42 s, coût nul. Amorçage des instantanés ; 12 événements pour les seules entrées datées de moins de 48 h (3 PR d'inférence, 4 dépôts HF dont trois `XiaomiMiMo/MiMo-V2.6-*`, 5 dépôts GitHub). Rejeu immédiat avec `--force` : voir le compte rendu du commit 5a.

## Ce que ces constats ne prouvent pas

Un événement de catalogue est une observation datée, pas une prédiction. La valeur d'avance de chaque catalogue (les précédents de la section 10.2) ne sera mesurée qu'au sous-lot 5d, par étiquetage à 72 h contre le top 20 du radar, deux familles ou la presse.
