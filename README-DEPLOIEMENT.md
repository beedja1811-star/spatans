# Déploiement — Empire des Spatiates

## Mise à jour du service existant

1. Mettre à jour le dépôt GitHub existant sur une branche de travail, jamais directement sur `main`.
2. Vérifier les changements puis fusionner la branche uniquement après validation.
3. Utiliser le service Railway existant. Ne pas créer un nouveau projet ou service pour cette mise à jour.
4. Conserver le Volume Railway déjà monté sur `/app/data` et la variable `DATA_DIR=/app/data`. Ne pas supprimer ni remplacer ce volume.
5. Vérifier que les variables `NODE_ENV=production`, `ADMIN_USER`, `ADMIN_PASS`, `TZ_NAME=America/Port-au-Prince` et les paramètres proxy existants sont corrects. Ne pas partager les secrets.
6. Après déploiement, vérifier `https://<domaine>/healthz`, puis tester la candidature, la réservation et le dashboard.

## Protection de la base de données

- Le dossier local `data/` est volontairement exclu de cette archive et ajouté à `.gitignore`.
- Ne jamais pousser la base SQLite locale, `empire.db`, `empire.db-wal`, `empire.db-shm`, `leads.json` ou `bookings.json` vers le dépôt.
- La base de production doit rester sur le Volume Railway existant (`/app/data`).
- `store.js` ajoute les nouvelles colonnes manquantes au démarrage. Cette migration touche la base de production ; ne déployer qu'après avoir confirmé qu'une sauvegarde récente du volume existe.
- `RATE_LIMIT=off` est réservé aux tests locaux. Ne jamais le définir sur Railway.
