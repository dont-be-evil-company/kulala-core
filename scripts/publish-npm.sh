#!/usr/bin/env bash
set -euo pipefail

WRAPPER_DIR="packages/core-npm-wrapper"

if [ -z "${VERSION:-}" ]; then
  echo "VERSION environment variable is not set. Exiting."
  exit 1
fi

bun install --frozen-lockfile

npm --prefix "${WRAPPER_DIR}" version "${VERSION}" --no-git-tag-version

sed -i "s/export const KULALA_CORE_VERSION = \".*\";/export const KULALA_CORE_VERSION = \"${VERSION}\";/" "${WRAPPER_DIR}/src/versions/backend.ts"

cd "${WRAPPER_DIR}"
rm -rf dist/*
bun run build
# npm publish --access public

if [ "${RESET_VERSIONS:-false}" = "true" ]; then
  cd ../../ && npm --prefix "${WRAPPER_DIR}" version "0.0.0" --no-git-tag-version
fi
