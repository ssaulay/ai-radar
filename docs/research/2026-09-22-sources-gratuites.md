# Recensement des sources gratuites de signal IA (22 septembre 2026)

Synthèse de la recherche menée le 22/09/2026 par appels réels (curl depuis un réseau français) et lecture des documentations. [V] vérifié par appel, [D] documentation officielle, [T] source tierce non recoupée. Les conditions changent vite : re-vérifier avant de s'appuyer sur une source.

## Constats qui ont changé le plan

1. Bluesky `searchPosts` exige une authentification (403 sans jeton) [V] ; compte gratuit et mot de passe d'application suffisent. Feeds, fils d'auteurs et tendances restent publics [V].
2. Reddit sans OAuth est quasi inutilisable depuis un serveur : `.json` = 403, `.rss` limité à environ 1 requête par minute, `search.rss` 429 [V]. OAuth gratuit mais approbation manuelle (Responsible Builder Policy, juin 2026) [T].
3. GDELT DOC API : 429 fréquents et réponses de 12 à 14 s [V] ; fichiers bruts toutes les 15 minutes fiables [V].
4. YouTube Data API : quota par défaut réduit à 100 `search.list` par jour (page officielle du 14/09/2026) [D] ; RSS par chaîne sans clé [V].
5. Polymarket bloqué en France : DNS vers `offre-illegale.anj.fr` [V].
6. X : plus de palier gratuit depuis février 2026, facturation à l'usage [T] ; mesuré par Simon : 24 requêtes de lecture = 0,66 USD.
7. Wikimedia : 10 requêtes par minute sans User-Agent descriptif, 200 avec [D]. Pageviews horaires par article indisponibles ; top J-1 disponible le lendemain matin [V].
8. Papers with Code fermé, redirige vers `huggingface.co/papers/trending` [V].
9. Google Trends : toujours pas d'API ouverte ; seul le RSS « trending now » répond [V].

## Tableau récapitulatif

| Source | Accès | Gratuit | Débit | Latence | Signal avancé /5 | Risque ToS /5 |
|---|---|---|---|---|---|---|
| HN Firebase + Algolia | JSON sans clé [V] | oui | illimité / 10k/h | secondes | 5 | 1 |
| HF Hub trending + daily_papers | JSON sans clé [V] | oui | 500/5 min | temps réel | 5 | 1 |
| Bluesky search (compte) + Jetstream | XRPC / websocket | oui | 3 000/5 min/IP | secondes | 4 | 1 |
| Bluesky feeds/trends publics | XRPC sans clé [V] | oui | non doc. | secondes | 3 | 1 |
| Reddit RSS / OAuth | RSS fragile, OAuth 100/min | oui (non commercial) | très bas sans auth | secondes | 4 | 3 |
| GH Archive + GitHub search | fichiers + API [V] | oui | 10-30/min | 1-2 h | 4 | 1 |
| OpenRouter models | JSON sans clé [V] | oui | non doc. | jour J | 4 | 1 |
| Simon Willison, Latent Space, Interconnects | RSS [V] | oui | - | heures | 4 / 3 | 1 |
| Techmeme | RSS [V] | oui | - | 1-3 h | 3 | 1 |
| Kalshi / Manifold | JSON sans clé [V] | oui | 500/min (Manifold) | temps réel | 3 | 1 |
| Mastodon tags + trends | JSON/RSS [V] | oui | 300/5 min | secondes | 3 | 1 |
| arXiv RSS/API | RSS/Atom [V] | oui | 1 req/3 s | 4-8 h | 3 | 1 |
| Blogs labos (OpenAI, DeepMind, HF, MSR, NVIDIA) | RSS [V] | oui | - | minutes | 3 | 1 |
| Forums Discourse (OpenAI, HF, Cursor) | RSS [V] | oui | - | secondes | 3 | 1 |
| Product Hunt | Atom / GraphQL token | oui | 6 250 pts/15 min | quotidien | 3 | 2 |
| Wikimedia EventStreams | SSE [V] | oui | 200/min | temps réel | 3 | 1 |
| Telegram t.me/s | HTML [V] | oui | - | secondes | 3 | 4 (ToS) |
| Google News RSS EN/FR | RSS [V] | oui | non doc. | minutes | 2 | 2 |
| GDELT DOC + fichiers 15 min | JSON / CSV [V] | oui | 429 fréquents | 15-30 min | 2 | 1 |
| Presse tech EN/FR | RSS [V] | oui | - | heures | 2 | 1 |
| Google Trends RSS | RSS [V] | oui | - | heures | 2 | 2 |
| YouTube RSS | RSS sans clé [V] | oui | - | minutes | 2 | 1 |
| Wikimedia pageviews | REST [V] | oui | 200/min | J+1 | 1 | 1 |
| Podcasts RSS | RSS [V] | oui | - | jours | 1 | 1 |
| X API | pay-per-use | non | - | - | - | - |
| Polymarket | bloqué FR [V] | oui hors FR | - | - | 3 | 1 |
| Feedly / Inoreader API | payant | non | - | - | - | 3 |
| Discord, LinkedIn | impossible | - | - | - | - | - |

## Flux vérifiés utiles

- Blogs officiels : `https://openai.com/news/rss.xml`, `https://deepmind.google/blog/rss.xml`, `https://blog.google/technology/ai/rss/`, `https://research.google/blog/rss/`, `https://huggingface.co/blog/feed.xml`, `https://www.microsoft.com/en-us/research/feed/`, `https://blogs.nvidia.com/feed/`, `https://developer.nvidia.com/blog/feed`, `https://mistral.ai/rss.xml` (pauvre), `https://engineering.fb.com/feed/`. Anthropic : aucun flux officiel ; tiers `https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml`. xAI, Perplexity, Cohere, Stability, DeepSeek, Qwen : pas de flux exploitable.
- Newsletters et blogs : Simon Willison `https://simonwillison.net/atom/everything/`, Import AI, Latent Space, Interconnects, One Useful Thing, The Rundown, TLDR AI, Ben's Bites, AINews, LessWrong front page. The Batch : pas de flux.
- Presse EN : TechCrunch AI, The Verge AI, Ars Technica, MIT Tech Review AI, Wired AI, The Information (titres), 404 Media. Bloomberg Tech, FT AI. VentureBeat 429, Reuters 401.
- Presse FR : Le Monde IA `https://www.lemonde.fr/intelligence-artificielle/rss_full.xml`, Numerama, FrenchWeb, Maddyness, ActuIA, Usine Digitale, JDN, 01net, Hub France IA. Les Echos et LeBigData 403.
- Forums : `https://community.openai.com/latest.rss`, `https://discuss.huggingface.co/latest.rss`, `https://forum.cursor.com/latest.rss`.
- Marchés : Kalshi `https://api.elections.kalshi.com/trade-api/v2/markets?status=open&series_ticker=...` (séries KXGPT6, KXCLAUDE, KXTOPMODEL, KXAIRELEASE, KXOAIAGI), Manifold `https://api.manifold.markets/v0/search-markets`.
- Conférences : `https://raw.githubusercontent.com/ccfddl/ccf-deadlines/main/conference/AI/{nips,icml,iclr}.yml`.

## Classement des 15 sources les plus utiles pour détecter tôt

1. Hacker News (Firebase + Algolia). 2. Hugging Face Hub trending. 3. Bluesky avec compte (search + Jetstream). 4. HF daily_papers. 5. Reddit via OAuth (r/LocalLLaMA, r/singularity, r/ClaudeAI, r/OpenAI). 6. GH Archive + GitHub search. 7. OpenRouter /models. 8. Simon Willison. 9. Techmeme. 10. Kalshi + Manifold. 11. Blogs officiels des labos. 12. Forums Discourse. 13. Mastodon tags et trends. 14. arXiv multi-catégories comme corpus. 15. Google News RSS EN + FR comme thermomètre de reprise.

## Non vérifié ou à surveiller

Limite exacte d'Algolia HN, fenêtre de replay Jetstream, limites Podcast Index et OpenAlex, comportement de Reddit depuis une IP GitHub Actions, saturation GDELT passagère ou durable, conditions d'utilisation de Google News RSS.
