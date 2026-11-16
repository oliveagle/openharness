#!/usr/bin/env node
// Writes the `.apk-info.json` the APK server's page reads, from `aapt2 dump badging` on stdin.
//
//   aapt2 dump badging app-release.apk | APK_SHA256=… APK_API=… APK_PAIR_HOST=… \
//     APK_INFO_PATH=app-release-info.json node scripts/apk-info.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const badging = readFileSync(0, 'utf8');
const field = (re) => badging.match(re)?.[1] ?? 'unknown';
const info = {
  package: field(/package: name='([^']+)'/),
  label: field(/^application-label:'([^']+)'/m),
  versionName: field(/versionName='([^']+)'/),
  versionCode: field(/versionCode='([^']+)'/),
  sha256: process.env.APK_SHA256 ?? 'unknown',
  api: process.env.APK_API ?? '',
  pairHost: process.env.APK_PAIR_HOST ?? '',
};
writeFileSync(process.env.APK_INFO_PATH, JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify(info));
