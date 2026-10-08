#!/bin/sh
set -e
REPO="KILYBMW/mi-teslabox"
BRANCH="${TESLABOX_BRANCH:-customS3}"
DIR="mi-teslabox-$BRANCH"

cd /root
curl -fsSL -o main.zip "https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH"
unzip -o main.zip
cp -r "$DIR"/* teslabox
rm -rf "$DIR"
rm main.zip
cd teslabox
npm ci --omit=dev
systemctl restart teslabox
