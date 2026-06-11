// Within the OLD project (gpsin-6fccb), move `alerts` and `follow_up`
// subcollections from `appMode/release/` to `<year>/release/` — consistent
// with the existing `2023/release/*` and `2024/release/*` archives.
//
// Three explicit phases — dry-run by default, never both write and delete in
// one invocation, and delete-source refuses unless target ≥ source counts
// (so a half-failed copy can't leave you with data loss).
//
// Usage:
//   node scripts/archive-to-year.mjs                         # dry-run
//   node scripts/archive-to-year.mjs --phase=copy            # real copy
//   node scripts/archive-to-year.mjs --phase=delete-source   # delete from appMode/release
//   (override year with --year=2026 etc.)

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credsDir = path.resolve(__dirname, '..', 'creds');

const { values } = parseArgs({
  options: {
    phase: { type: 'string', default: 'dry-run' },
    year: { type: 'string', default: '2025' },
  },
});
if (!['dry-run', 'copy', 'delete-source'].includes(values.phase)) {
  console.error('--phase must be one of: dry-run | copy | delete-source');
  process.exit(1);
}
const phase = values.phase;
const year = values.year;

const cred = JSON.parse(readFileSync(path.join(credsDir, 'old.json'), 'utf8'));
const app = admin.initializeApp(
  { credential: admin.credential.cert(cred) },
  'old',
);
const db = app.firestore();

const COLLECTIONS = ['alerts', 'follow_up'];
const SOURCE_PARENT = db.collection('appMode').doc('release');
const TARGET_PARENT = db.collection(year).doc('release');

async function counts() {
  const out = {};
  for (const name of COLLECTIONS) {
    const src = (await SOURCE_PARENT.collection(name).count().get()).data().count;
    const dst = (await TARGET_PARENT.collection(name).count().get()).data().count;
    out[name] = { src, dst };
  }
  return out;
}

async function dryRun() {
  const c = await counts();
  console.log(`Source: appMode/release   Target: ${year}/release\n`);
  for (const name of COLLECTIONS) {
    console.log(`[${name}]  source=${c[name].src}   target=${c[name].dst}`);
  }
}

async function copy() {
  console.log(`Copying appMode/release/* → ${year}/release/*\n`);
  for (const name of COLLECTIONS) {
    const src = await SOURCE_PARENT.collection(name).get();
    console.log(`[${name}] ${src.size} docs to copy`);
    if (src.empty) continue;
    const BATCH = 400;
    let batch = db.batch();
    let count = 0;
    for (const doc of src.docs) {
      batch.set(TARGET_PARENT.collection(name).doc(doc.id), doc.data());
      count += 1;
      if (count % BATCH === 0) {
        await batch.commit();
        batch = db.batch();
        console.log(`  committed ${count}/${src.size}`);
      }
    }
    if (count % BATCH !== 0) await batch.commit();
    console.log(`[${name}] DONE — ${count} docs written.`);
  }
}

async function deleteSource() {
  const c = await counts();
  for (const name of COLLECTIONS) {
    if (c[name].dst < c[name].src) {
      console.error(
        `REFUSING TO DELETE: [${name}] source=${c[name].src} > target=${c[name].dst}. Run --phase=copy first and verify.`,
      );
      process.exit(1);
    }
    console.log(`[${name}] verified: source=${c[name].src}, target=${c[name].dst}`);
  }
  console.log('\nProceeding with source deletion.\n');
  for (const name of COLLECTIONS) {
    const src = await SOURCE_PARENT.collection(name).get();
    console.log(`[${name}] deleting ${src.size} docs from appMode/release/${name}`);
    const BATCH = 400;
    let batch = db.batch();
    let count = 0;
    for (const doc of src.docs) {
      batch.delete(doc.ref);
      count += 1;
      if (count % BATCH === 0) {
        await batch.commit();
        batch = db.batch();
        console.log(`  deleted ${count}/${src.size}`);
      }
    }
    if (count % BATCH !== 0) await batch.commit();
    console.log(`[${name}] DELETED — ${count} docs.`);
  }
}

try {
  switch (phase) {
    case 'dry-run':
      await dryRun();
      break;
    case 'copy':
      await copy();
      break;
    case 'delete-source':
      await deleteSource();
      break;
  }
} finally {
  await app.delete();
}
console.log('\nDone.');
