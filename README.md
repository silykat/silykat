# local-review

Skills & VSCode extension for local code review.

Une code review « façon GitHub », 100 % locale, entre vous et Claude Code :

- **Extension VS Code** (`packages/extension`) : sélectionner des lignes (dans un fichier ou un diff) et les commenter, soit en commentaire direct, soit en mode review.
- **Skill Claude Code** (à venir) : Claude lit les commentaires, modifie le code et répond dans les fils.

Les commentaires sont stockés dans `.local-review/` à la racine du projet commenté. Ce dossier est exclu de git automatiquement via `.git/info/exclude`. Aucune donnée ne quitte la machine.

## Développement

Prérequis : Node ≥ 20 et la commande `code` dans le PATH.

```sh
npm install
npm run typecheck          # TypeScript, tous les packages
npm test                   # tests unitaires (vitest)
npm run test:integration   # tests d'intégration dans une instance VS Code dédiée
npm run install-ext        # construit le .vsix et l'installe dans VS Code
```

Après `install-ext`, lancez **Developer: Reload Window** dans VS Code.

| Package | Rôle |
|---|---|
| `packages/core` | Modèle de données, journal JSONL, stockage. Aucune dépendance à `vscode` |
| `packages/extension` | Extension VS Code |
