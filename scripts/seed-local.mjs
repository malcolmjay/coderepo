// Demo identities are confined to explicitly named local emulators.
import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
initializeApp({projectId: 'demo-camera-portal'});
const db = getFirestore();
for (const [email, role] of [['admin@example.com', 'admin'], ['customer@example.com', 'customer']]) {
  await db.collection('members').doc(email).set({email, role, active: true, validAfter: 0, source: 'Local demo only', createdAt: Date.now(), updatedAt: Date.now()});
}
console.log('Local demo ready: admin@example.com and customer@example.com. Sign-in links appear in the Auth emulator terminal.');
await db.terminate();
