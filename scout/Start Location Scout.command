#!/bin/bash
# Dubbelklik om Location Scout te starten (Mac).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is niet gevonden. Installeer de LTS-versie van https://nodejs.org en probeer opnieuw."
  read -r -p "Druk op Enter om te sluiten."
  exit 1
fi
node setup.mjs --check-node || { read -r -p "Druk op Enter om te sluiten."; exit 1; }

if [ ! -d node_modules ]; then
  echo "Eerste keer: onderdelen installeren..."
  npm install --no-audit --no-fund || { read -r -p "Installeren mislukt. Druk op Enter om te sluiten."; exit 1; }
fi

echo "Location Scout start en opent je browser. Laat dit venster open zolang je de app gebruikt."
npm start -- --open
