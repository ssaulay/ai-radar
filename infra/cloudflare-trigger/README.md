# Déclencheur externe du radar (Worker Cloudflare)

## Pourquoi

Le cron GitHub Actions de `radar.yml` (`7,37 * * * *`) n'est pas fiable : GitHub documente que les passages
planifiés « peuvent être retardés en période de forte charge » et que « certains jobs en file peuvent être
abandonnés ». Constat des 22-23/09/2026 : un passage toutes les 3 h environ au lieu de toutes les 30 min.

Ce Worker (plan gratuit Cloudflare : 5 crons par compte, 100 000 requêtes par jour) appelle l'API GitHub
`POST /repos/ssaulay/ai-radar/actions/workflows/radar.yml/dispatches` aux minutes 7 et 37 de chaque heure (UTC)
avec l'input `source=cloudflare-cron`. Le cron GitHub est conservé en secours. Le job `garde` du workflow saute
tout passage planifié si le dernier passage ayant sauvegardé l'état a démarré il y a moins de 20 min, donc les
deux planificateurs se doublent sans coût. Les déclenchements manuels (source `manuel` ou `force=true`) ne sont
jamais sautés.

## Mise en place (une fois, par Simon)

1. **Jeton GitHub à granularité fine** : GitHub > Settings > Developer settings > Fine-grained tokens > Generate.
   Resource owner `ssaulay`, accès au seul dépôt `ai-radar`, permission de dépôt **Actions : Read and write**
   (permission requise par la doc GitHub pour « Create a workflow dispatch event »), aucune autre permission.
   Expiration : au plus 1 an, noter la date de renouvellement dans la mémoire du projet. Ce jeton ne peut ni lire
   les secrets du dépôt ni pousser du code.
2. **Compte Cloudflare** (gratuit) puis connexion locale :
   ```bash
   cd infra/cloudflare-trigger
   npx -y wrangler@4 login          # ouvre le navigateur
   ```
3. **Déploiement et secrets** :
   ```bash
   npx -y wrangler@4 deploy
   npx -y wrangler@4 secret put GITHUB_TOKEN   # coller le jeton de l'étape 1
   npx -y wrangler@4 secret put TRIGGER_KEY    # clé libre, longue, pour le déclenchement manuel POST /dispatch
   ```
4. **Test immédiat** (sans attendre le cron) :
   ```bash
   curl -s -X POST -H "x-trigger-key: <TRIGGER_KEY>" https://ai-radar-trigger.<sous-domaine>.workers.dev/dispatch
   ```
   Réponse attendue `{"status":204,"body":""}` puis, dans GitHub Actions, un run nommé « radar · cloudflare-cron ».
   Si l'état a été sauvegardé il y a moins de 20 min, le job `garde` le saute avec une annotation ; c'est le
   comportement attendu.

## Vérifier que ça tourne

```bash
gh run list --repo ssaulay/ai-radar --limit 20 --json displayTitle,createdAt,conclusion \
  --jq '.[] | "\(.createdAt) \(.displayTitle) \(.conclusion)"'
npx -y wrangler@4 tail            # journaux du Worker en direct (une ligne JSON par déclenchement)
```

Succès attendu après 24 h : au moins 46 runs dont la plupart « radar · cloudflare-cron », aucun trou de plus
de 40 min, et les runs « cron GitHub » majoritairement sautés par le garde-fou.

## Ce que le Worker ne fait pas

- Il ne porte aucune logique du radar : un seul appel HTTP, le workflow reste la seule source de vérité.
- Il ne lit rien du dépôt et ne stocke rien.
- Sans `TRIGGER_KEY` configurée, `POST /dispatch` répond 401 : le déclenchement manuel est fermé par défaut.

## Tests

`node --test tests/trigger.test.mjs` (à la racine du dépôt) couvre la requête construite, la gestion des
erreurs GitHub, l'authentification de `/dispatch` et le gestionnaire `scheduled`, sans réseau.
