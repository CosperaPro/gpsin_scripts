// Read-only diagnostic. Lists the subcollections under `appMode/release/`
// in the old project, plus a count of docs in `alerts` and `follow_up`
// (or whatever close-match names exist) and any sub-subcollections found
// on the first doc of each.
//
// Usage:
//   node scripts/inspect-old-release.mjs

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credsDir = path.resolve(__dirname, '..', 'creds');
const cred = JSON.parse(readFileSync(path.join(credsDir, 'old.json'), 'utf8'));

const app = admin.initializeApp(
  { credential: admin.credential.cert(cred) },
  'old',
);
const db = app.firestore();
const parent = db.collection('appMode').doc('release');

const subs = await parent.listCollections();
console.log(`Subcollections under appMode/release/: ${subs.length}`);
for (const c of subs) console.log(`  - ${c.id}`);

console.log('');
for (const c of subs) {
  const snap = await c.count().get();
  const docCount = snap.data().count;
  console.log(`[${c.id}] ${docCount} docs`);
  if (docCount === 0) continue;
  const sample = await c.limit(1).get();
  const doc = sample.docs[0];
  const nested = await doc.ref.listCollections();
  if (nested.length === 0) {
    console.log(`  (no nested subcollections on sample doc ${doc.id})`);
  } else {
    console.log(`  Sample doc ${doc.id} has nested subcollections:`);
    for (const n of nested) {
      const ns = await n.count().get();
      console.log(`    - ${n.id} (${ns.data().count} docs)`);
    }
  }
}

await app.delete();
