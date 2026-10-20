#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REVIEW_OUT="$ROOT/tmp/ai/screenshot-review"
mkdir -p "$REVIEW_OUT"
npm run build:app-deps:clean
(cd packages/app && PASEO_WEB_PLATFORM=electron npm exec -- expo export --platform web)
npm run build:server:clean
npm run build:main --workspace=@getpaseo/desktop
node --input-type=module - "$ROOT" <<'JS'
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const config = {
  extends: path.join(root, "packages/desktop/electron-builder.yml"),
  appId: "sh.paseo.review",
  productName: "Paseo Review",
  executableName: "Paseo Review",
  protocols: [{ name: "Paseo Review agent link", schemes: ["paseo-review"] }],
  extraMetadata: { version: `${version}-review.1` },
  directories: { output: path.join(root, "tmp/ai/screenshot-review/build") },
  mac: { identity: "-", notarize: false, hardenedRuntime: false },
};
fs.writeFileSync(path.join(root, "tmp/ai/screenshot-review/electron-builder.json"), JSON.stringify(config, null, 2));
JS
(cd packages/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npm exec -- electron-builder --config "$REVIEW_OUT/electron-builder.json" --mac --arm64 --dir --publish never)
