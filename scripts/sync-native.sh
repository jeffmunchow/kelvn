#!/usr/bin/env bash
#
# sync-native.sh — Sincroniza o app web (app/) para o app nativo Capacitor/Xcode.
#
# REGRA DO PROJETO: toda alteração em app/kelvn.html, app/album.html ou em assets
# (vendor/, ícone, manifest) PRECISA ser refletida no app nativo da App Store.
# Este script garante que o bundle que o Xcode empacota nunca fique defasado da
# fonte — foi a falta dessa sincronização que escondeu a versão bugada v1.8.2 no
# app nativo enquanto a web já estava corrigida.
#
# Uso:  bash scripts/sync-native.sh
# Depois: recompilar no Xcode (ou rodar o build do Mac Catalyst).
#
set -euo pipefail

# node/npm instalados localmente (sem Homebrew) — garante no PATH
export PATH="$HOME/.local/node/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ Copiando arquivos web para native/www/"
cp app/kelvn.html          native/www/index.html
cp app/album.html          native/www/album.html
mkdir -p native/www/app
cp app/feedback-widget.js  native/www/app/feedback-widget.js
cp app/icon.png            native/www/icon.png
cp app/manifest.json       native/www/manifest.json
rm -rf native/www/vendor
cp -R app/vendor           native/www/vendor

echo "→ npx cap copy ios  (native/www → native/ios/App/App/public)"
( cd native && npx cap copy ios )

# Verificação: a versão no bundle do Xcode tem que bater com a fonte
SRC_V="$(grep -m1 "var APP_VERSION" app/kelvn.html | tr -d ' ')"
DST_V="$(grep -m1 "var APP_VERSION" native/ios/App/App/public/index.html | tr -d ' ')"
echo "  fonte : $SRC_V"
echo "  bundle: $DST_V"
if [ "$SRC_V" != "$DST_V" ]; then
  echo "✗ DIVERGÊNCIA de versão entre fonte e bundle nativo — abortar." >&2
  exit 1
fi

echo "✓ App nativo sincronizado com a fonte. Agora recompile no Xcode."
