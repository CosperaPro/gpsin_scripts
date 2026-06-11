// Read-only diagnostic: list auth UIDs in gpsin-prod that have no matching
// document in the `users` collection (where `auth_token` == uid). These are
// the users who, post-migration, can authenticate but get bounced to LoginUI
// by AppRouter because no profile doc exists.
//
// Usage:
//   node scripts/list-orphan-auth.mjs

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credsDir = path.resolve(__dirname, '..', 'creds');
const cred = JSON.parse(readFileSync(path.join(credsDir, 'prod.json'), 'utf8'));

const app = admin.initializeApp(
  { credential: admin.credential.cert(cred) },
  'prod',
);
const auth = app.auth();
const db = app.firestore();

const authUsers = new Map(); // uid -> { email, creation, lastSignIn }
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const u of page.users) {
    authUsers.set(u.uid, {
      email: u.email ?? '(no email)',
      creation: u.metadata.creationTime,
      lastSignIn: u.metadata.lastSignInTime,
    });
  }
  pageToken = page.pageToken;
} while (pageToken);

const usersSnap = await db.collection('users').get();
const docUids = new Set();
for (const d of usersSnap.docs) {
  const at = d.data().auth_token;
  if (at) docUids.add(at);
}

const orphans = [...authUsers.entries()].filter(([uid]) => !docUids.has(uid));
console.log(
  `Auth: ${authUsers.size}   /users docs (with auth_token): ${docUids.size}   Orphans: ${orphans.length}\n`,
);
for (const [uid, info] of orphans) {
  console.log(
    `  ${uid}\n    email=${info.email}\n    created=${info.creation}\n    lastSignIn=${info.lastSignIn ?? 'never'}\n`,
  );
}

await app.delete();
