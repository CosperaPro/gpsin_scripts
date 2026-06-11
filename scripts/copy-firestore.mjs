// Copy Firestore collections from the old project's `appMode/release/<name>`
// subcollections into a target project's root `<name>` collection.
//
// Source doc IDs are preserved, so re-running the script overwrites in place
// (idempotent) instead of duplicating documents.
//
// Usage:
//   node scripts/copy-firestore.mjs --target dev --dry-run
//   node scripts/copy-firestore.mjs --target dev
//   node scripts/copy-firestore.mjs --target stg
//   node scripts/copy-firestore.mjs --target prod
//   node scripts/copy-firestore.mjs --target prod --collections=users
//
// Credentials are loaded from:
//   creds/old.json        (read source)
//   creds/<target>.json   (write target — dev.json / stg.json / prod.json)

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credsDir = path.resolve(__dirname, '..', 'creds');

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    collections: {
      type: 'string',
      default: 'municipality,agglomeration,admin_configuration',
    },
  },
});

const target = values.target;
if (!['dev', 'stg', 'prod'].includes(target)) {
  console.error('--target must be one of: dev, stg, prod');
  process.exit(1);
}
const dryRun = values['dry-run'];
const collections = values.collections
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const sourceCred = JSON.parse(readFileSync(path.join(credsDir, 'old.json'), 'utf8'));
const targetCred = JSON.parse(readFileSync(path.join(credsDir, `${target}.json`), 'utf8'));

console.log(
  `Source project: ${sourceCred.project_id}  →  Target project: ${targetCred.project_id}` +
    (dryRun ? '  [DRY RUN]' : ''),
);

const sourceApp = admin.initializeApp(
  { credential: admin.credential.cert(sourceCred) },
  'source',
);
const targetApp = admin.initializeApp(
  { credential: admin.credential.cert(targetCred) },
  'target',
);

const src = sourceApp.firestore();
const dst = targetApp.firestore();

// Source nesting: collection `appMode`, document `release`, then the
// per-collection subcollections.
const SOURCE_PARENT = src.collection('appMode').doc('release');

async function copyCollection(name) {
  const srcRef = SOURCE_PARENT.collection(name);
  const snapshot = await srcRef.get();
  console.log(`[${name}] read ${snapshot.size} docs from appMode/release/${name}`);
  if (snapshot.empty) return;

  if (dryRun) {
    const sample = snapshot.docs.slice(0, 3);
    for (const doc of sample) {
      console.log(`[${name}] sample ${doc.id}:`, JSON.stringify(doc.data()).slice(0, 200));
    }
    console.log(
      `[${name}] DRY RUN — ${snapshot.size} docs would be written to ${target}/${name}`,
    );
    return;
  }

  // Firestore batches max out at 500 ops; stay under that.
  const BATCH = 400;
  let batch = dst.batch();
  let count = 0;
  for (const doc of snapshot.docs) {
    batch.set(dst.collection(name).doc(doc.id), doc.data());
    count += 1;
    if (count % BATCH === 0) {
      await batch.commit();
      batch = dst.batch();
      console.log(`[${name}] committed ${count}/${snapshot.size}`);
    }
  }
  if (count % BATCH !== 0) await batch.commit();
  console.log(`[${name}] DONE — ${count} docs written to ${target}/${name}`);
}

try {
  for (const c of collections) {
    await copyCollection(c);
  }
} finally {
  await sourceApp.delete();
  await targetApp.delete();
}
console.log('All done.');
