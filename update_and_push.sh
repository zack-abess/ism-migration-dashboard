#!/bin/bash
# update_and_push.sh
# ==================
# Régénère les données du dashboard et push vers GitHub Pages.
# Le repo git est dans le dossier dashboard/ lui-même.
#
# Usage manuel:  cd scraper-classexpert-v2/dashboard && ./update_and_push.sh
# Usage cron:    */30 * * * * cd ~/Documents/Groupe\ ISM/schoolArt/scraper-classexpert-v2/dashboard && ./update_and_push.sh >> cron.log 2>&1

set -e

# Charger le PATH complet (node, git, etc.) — nécessaire pour cron
export PATH="/Users/mac/Library/Application Support/Herd/config/nvm/versions/node/v22.22.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "$(date '+%Y-%m-%d %H:%M:%S') 🔄 Mise à jour du dashboard..."

# 1. Régénérer les données (le script a besoin d'être lancé depuis le projet parent)
cd "$PROJECT_DIR"
node dashboard/generate_dashboard_data.js

# 2. Vérifier s'il y a des changements (dans le repo dashboard/)
cd "$SCRIPT_DIR"
if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ℹ️  Aucun changement détecté, skip push."
  exit 0
fi

# 3. Commit & push depuis le dossier dashboard/
git add -A
git commit -m "📊 update data $(date '+%Y-%m-%d %H:%M')"
git push origin main

echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ Dashboard mis à jour et poussé."
