# Méthodes de détection de tendances à coût quasi nul (22 septembre 2026)

Synthèse de la recherche du 22/09/2026 : mesures directes, formules, seuils de départ et recommandations. [V] vérifié, [S] source secondaire, [E] estimation à calibrer.

## Mesures directes qui contraignent la conception

| Source | Résultat [V] | Conséquence |
|---|---|---|
| HN Firebase | sans limite | snapshot topstories + newstories toutes les 15 à 30 min |
| HN Algolia search_by_date | points, num_comments, created_at_i ; 10 000 req/h/IP [S] | delta de la dernière heure en une requête |
| Reddit .json anonyme | 403 | mort depuis mai 2026 |
| Reddit .rss | 200 mais sans score ; search.rss 429 | présence seulement, pas de vélocité |
| Bluesky searchPosts | 403 sur public.api, 200 sur api.bsky.app | jeton recommandé |
| Bluesky Jetstream | environ 45 événements/s, 3,5 M posts/jour | streaming permanent, incompatible avec un cron |
| HF /api/daily_papers | upvotes, githubRepo, githubStars | signal papier + code |
| GDELT timelinevolraw | résolution 15 min, refus sous 5 s d'intervalle | évaluation nocturne seulement |
| Google News RSS when:1h | items de moins de 40 min | frais si filtré par `when:` |
| arXiv RSS | régénéré une fois par jour (20 h ET) | jamais un signal horaire |
| GitHub search sans auth | 10/min ; 30/min avec jeton | vélocité d'étoiles à calculer par snapshots |
| Wikimedia pageviews | daily seulement par article ; top J-1 à 10 h 30 UTC | confirmation, pas anticipation |
| Polymarket | DNS ANJ | bloqué en France |
| Manifold /v0/search-markets | 200 sans clé, 500 req/min/IP | utilisable |

## 1. Détection de burst

**Z-score par terme et fenêtre** : `c_t(w)` = items distincts mentionnant `w` dans la fenêtre ; baseline `μ, σ` sur les fenêtres précédentes (7 jours, saisonnalisée par heure de la semaine) ; `z = (c_t − μ) / max(σ, √μ, 1)`. Plancher Poisson `√μ`. Déclenchement [E] : `z ≥ 3` et `c_t ≥ 5` et `c_t ≥ 2·μ`. Le minimum absolu est indispensable : 0 puis 2 occurrences donne un z infini.

**Kleinberg 2002** (batch, §4 du papier) : états `q_i` avec `p_i = p_0·s^i`, `p_0 = R/D` ; coût d'émission `−ln[C(d_t, r_t)·p_i^{r_t}·(1−p_i)^{d_t−r_t}]` ; transition montante `(j−i)·γ·ln n`, descente gratuite ; programmation dynamique ; poids d'un burst = économie de coût entre états 0 et 1. Départ : fenêtres horaires, `n = 168`, `s = 2`, `γ = 1`. Avantage : un burst persiste à travers des trous courts sans heuristique.

**Vélocité par plateforme** : HN `score = (votes−1)^0,8 / (âge_h+2)^1,8` avec pénalités ; attention par rang (Quality News) : rang 1 ≈ 1,17 upvote/min, rang 40 ≈ 0,04 ; `upvoteRate = (upvotes+2,3)/(attendus+2,3)`. Seuil [E] : ≥ 10 points/h la première heure. Reddit `hot = log10(|ups−downs|) + signe·(t−1134028003)/45000`. GitHub : `Δ★/24 h` par snapshots ; ≥ 300 ★/24 h pour un dépôt de moins de 30 jours [E]. HF Papers : ≥ 20 upvotes en 24 h [E].

**Croisement multi-sources** : familles indépendantes A à H ; `n_fam(sujet, 6 h)` ; ≥ 2 émergent, ≥ 3 fort [E]. La presse (G) ne compte pas : elle bascule le statut en « repris ». Principe de Techmeme et d'Emergent Mind.

## 2. Regroupement à faible coût

Embeddings : OpenAI `text-embedding-3-small` 0,02 USD par million de tokens (≈ 0,11 USD/mois pour 3 000 items/jour) ; Cloudflare Workers AI `bge-small` ou `bge-m3` gratuit (10 000 neurones/jour) ; transformers.js local gratuit mais anglais. Clustering incrémental « leader » (lignée TDT) : dédup URL canonique et SimHash, embedding du titre + 200 caractères, comparaison aux clusters actifs (< 72 h), rejoindre si cos ≥ seuil sinon créer, fusion périodique, expiration. Seuils initiaux proposés [E] : 0,92 doublon, 0,80 même histoire ; **calibrés le 22/09 sur 700 voisins réels : doublons ≥ 0,80, même histoire 0,60 à 0,80** ; adopté : rejoindre à 0,62 (0,74 pour papiers et catalogues), avec double condition « un membre réel au-dessus du seuil et centroïde à moins de 0,06 en dessous » pour éviter la dérive par chaînage. HDBSCAN écarté (pas de lib JS mature, batch).

LLM uniquement pour nommer et résumer : `gpt-5.4-nano` 0,20 USD/M entrée, 1,25 USD/M sortie ≈ 0,75 USD/mois pour 50 clusters/jour ; Groq gratuit 200 000 tokens/jour.

## 3. Score et validation

Indicateurs avancés et niveau de preuve : HN puis front page (corrélation forte, pas d'étude quantitative) ; réseaux sociaux devançant la presse de quelques heures seulement et surtout sur la longue queue (Petrovic et al., ICWSM 2013) ; arXiv + HF + GitHub (Emergent Mind) prédictif de la presse spécialisée ; annonce officielle : reprise quasi certaine, la valeur est la latence ; marchés de prédiction pour les événements datés.

Score v1 : `25·min(1, n_fam/3) + 20·min(1, z/6) + 15·min(1, v_HN/10) + 10·min(1, Δ★/500) + 10·min(1, hf/20) + 10·[officiel] + 10·min(1, bsky/200)`. Statut séparé : presse avant et après détection. v2 après 4 à 6 semaines : régression logistique sur les composantes, calibration par score de Brier.

Validation a posteriori : à `t0`, figer une requête presse (2 à 3 entités), compter Google News `when:3d` et GDELT à +24 h, +48 h, +72 h ; `hit` si ≥ 3 articles grand public après et 0 avant ; précision@10, rappel inversé, avance médiane, Brier ; publier « Hier, nos appels ».

## 4. Outils existants

RSSHub (Telegram via t.me/s sans config, Bluesky keyword, X exige un cookie de compte) ; Miniflux, FreshRSS (lecteurs) ; Huginn, n8n (orchestration lourde) ; Techmeme (inspiration) ; Quality News (constantes d'attention HN) ; Emergent Mind (inspiration) ; Lobste.rs JSON ; HnTrends (SQLite suffit).

## 5. Hébergement

GitHub Actions : cron min 5 min, retards 5 à 30 min aux heures pleines, minutes illimitées en dépôt public, 2 000 min/mois en privé ; désactivation après 60 jours sans activité. Cloudflare Workers gratuit : 10 ms CPU par exécution, cron inclus ; D1 avec erreurs dures depuis le 01/09/2026 au-delà des quotas ; Workers AI gratuit pour les embeddings ; Pages illimité. Oracle Always Free : Arm 2 OCPU / 12 Go, récupération si machine idle 7 jours ; seule option pour du streaming. Fly.io, Railway : plus de gratuit. Render : services web gratuits en veille. Mac + launchd : développement seulement.

## 6. Page

Liste triée par score avec décomposition au survol, sparkline items/h 24 h, première détection et âge, badges par famille cliquables, puce presse, filtres, briefs, section « Hier, nos appels ».

## Recommandation retenue

Node.js + SQLite, dépôt GitHub public, Actions toutes les 30 min, état sur branche orpheline, Pages ; embeddings OpenAI small (512 dimensions), nommage LLM bon marché ; coût total sous 1 USD par mois ; validation sur 4 semaines avant toute affirmation de capacité d'anticipation. Cible raisonnable : précision@10 ≥ 50 %, avance médiane ≥ 3 h sur la presse tech.
