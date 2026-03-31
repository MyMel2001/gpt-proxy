#!/bin/bash
cd "$(dirname "$0")"
rm -rf browser-profiles/
git pull
npm i
node index.js >jippity.log 2>&1 &
