#!/bin/bash
# update_and_push.sh
# ==================
# Régénère les données du dashboard et push vers GitHub Pages.
#
# Usage manuel:  ./dashboard/update_and_push.sh
# Usage cron:    */30 * * * * cd /path/to/scraper-classexpert-v2 && ./dashboard/update_and_push.sh >> dashboard/cron.log 2>&1
#
# Prérequis: git remote "origin" configuré, branche main

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "$(date '+%Y-%m-%d %H:%M:%S') 🔄 Mise à jour du dashboard..."

# 1. Régénérer les données
node dashboard/generate_dashboard_data.js

# 2. Vérifier s'il y a des changements
cd dashboard
if git diff --quiet dashboard-data.json 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ℹ️  Aucun changement détecté, skip push."
  exit 0
fi

# 3. Commit & push
cd "$PROJECT_DIR"
git add dashboard/dashboard-data.json
git commit -m "📊 dashboard: update data $(date '+%Y-%m-%d %H:%M')"
git push origin main

echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ Dashboard mis à jour et poussé."
