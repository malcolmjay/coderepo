import {initializeApp, applicationDefault} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {email} from '../functions/lib/domain.js';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const projectId = args.includes('--project') ? value('--project') : '';
if (!projectId || !args.includes('--email') || (!args.includes('--grant') && !args.includes('--revoke'))) {
  console.error('Usage: node scripts/admin.mjs --project PROJECT_ID --email you@example.com --grant|--revoke');
  process.exit(1);
}
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Unset emulator variables before managing production administrators.');
const address = email(value('--email'));
const grant = args.includes('--grant');
if (grant && args.includes('--revoke')) throw new Error('Choose either --grant or --revoke.');
initializeApp({projectId, credential: applicationDefault()});
const db = getFirestore();
await db.runTransaction(async tx => {
  const reference = db.collection('members').doc(address);
  const snapshot = await tx.get(reference);
  if (!grant) {
    const admins = await tx.get(db.collection('members').where('role', '==', 'admin').where('active', '==', true));
    if (!snapshot.exists || snapshot.get('role') !== 'admin') throw new Error('This address is not an administrator.');
    if (!admins.docs.some(doc => doc.id !== address)) throw new Error('Grant another administrator access before revoking the last active administrator.');
  }
  const stamp = Date.now();
  tx.set(reference, {email: address, role: 'admin', active: grant, source: snapshot.get('source') || 'Administrator', validAfter: Math.floor(stamp / 1000) * 1000 + 1000, createdAt: snapshot.get('createdAt') || stamp, updatedAt: stamp});
  tx.create(db.collection('activity').doc(), {actor: 'Trusted project operator', action: grant ? 'Administrator granted' : 'Administrator revoked', target: address, createdAt: stamp});
});
console.log(`${grant ? 'Granted' : 'Revoked'} administrator access for ${address} in ${projectId}. A new sign-in is required.`);
await db.terminate();
