import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeApp as initializeAdmin, deleteApp as deleteAdmin} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getStorage as getAdminStorage} from 'firebase-admin/storage';
import {initializeTestEnvironment, assertFails, assertSucceeds} from '@firebase/rules-unit-testing';
import {doc, getDoc, setDoc} from 'firebase/firestore';
import {ref, uploadBytes, getBytes, getMetadata, updateMetadata, deleteObject} from 'firebase/storage';

const projectId = 'demo-camera-portal';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run tests with npm run test:emulators.');
const admin = initializeAdmin({projectId, storageBucket: `${projectId}.appspot.com`});
const db = getFirestore(admin);
let env;
let owner;
let customer;
let stranger;
let revoked;
let release;
const fields = {title: 'WLV-01 firmware', version: '3.2', kind: 'firmware', compatibility: 'IMX294', notes: 'Back up photos first.', sha256: ''};

async function json(url, body, headers = {}) {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
  return response.json();
}
async function login(address) {
  const endpoint = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:';
  const sent = await json(`${endpoint}sendOobCode?key=demo-key`, {requestType: 'EMAIL_SIGNIN', email: address, continueUrl: 'http://localhost:5173/', canHandleCodeInApp: true});
  assert(!sent.error, JSON.stringify(sent));
  const {oobCodes} = await (await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${projectId}/oobCodes`)).json();
  const code = oobCodes.filter(code => code.email === address && code.requestType === 'EMAIL_SIGNIN').at(-1);
  const result = await json(`${endpoint}signInWithEmailLink?key=demo-key`, {email: address, oobCode: code.oobCode});
  assert(result.idToken, JSON.stringify(result));
  return {token: result.idToken, uid: result.localId, email: address, oobCode: code.oobCode};
}
async function call(user, operation, data = {}) {
  const response = await json(`http://127.0.0.1:5001/${projectId}/northamerica-northeast1/portal`, {data: {operation, ...data}}, user ? {authorization: `Bearer ${user.token}`} : {});
  if (response.error) {const error = new Error(response.error.message); error.code = response.error.status; throw error;}
  return response.result;
}
async function denied(promise, code = 'PERMISSION_DENIED') {await assert.rejects(promise, error => error.code === code);}
function storage(user, overrides = {}) {
  return env.authenticatedContext(user.uid, {email: user.email, email_verified: true, auth_time: Math.floor(Date.now() / 1000), ...overrides}).storage(`gs://${projectId}.appspot.com`);
}

before(async () => {
  env = await initializeTestEnvironment({projectId,
    firestore: {host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.rules', 'utf8')},
    storage: {host: '127.0.0.1', port: 9199, rules: readFileSync('storage.rules', 'utf8')}});
  await env.clearFirestore();
  for (const [address, role, active] of [['admin@example.com', 'admin', true], ['customer@example.com', 'customer', true], ['revoked@example.com', 'customer', false]]) {
    await db.collection('members').doc(address).set({email: address, role, active, validAfter: 0, source: 'Test', createdAt: Date.now(), updatedAt: Date.now()});
  }
  owner = await login('admin@example.com'); customer = await login('customer@example.com'); stranger = await login('stranger@example.com'); revoked = await login('revoked@example.com');
});
after(async () => {await env?.cleanup(); await deleteAdmin(admin);});

test('real email-link sign-in grants only approved emails portal access', async () => {
  assert.equal((await call(customer, 'access')).role, 'customer');
  assert.equal((await call(owner, 'access')).role, 'admin');
  await denied(call(stranger, 'access'));
  await denied(call(revoked, 'access'));
  await denied(call(null, 'access'), 'UNAUTHENTICATED');
});
test('email links are one-time credentials', async () => {
  const replay = await json('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=demo-key', {email: customer.email, oobCode: customer.oobCode});
  assert(replay.error, 'a consumed sign-in code must not be redeemable twice');
});
test('customer cannot list members, change access, upload, edit, publish, or read audit records', async () => {
  for (const operation of ['customers', 'addCustomers', 'setAccess', 'beginUpload', 'completeUpload', 'saveRelease', 'publish', 'deleteDraft', 'activity']) await denied(call(customer, operation, {role: 'admin'}));
  await denied(call(customer, 'releases', {admin: true}));
});
test('all direct database reads and writes fail, including fake administrator claims', async () => {
  const context = env.authenticatedContext(owner.uid, {email: owner.email, email_verified: true, admin: true});
  await assertFails(getDoc(doc(context.firestore(), 'members/admin@example.com')));
  await assertFails(setDoc(doc(context.firestore(), 'members/stranger@example.com'), {role: 'admin', active: true}));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'releases/private')));
});
test('bulk add validates, normalizes, and leaves revoked addresses unchanged', async () => {
  const result = await call(owner, 'addCustomers', {emails: ' New@example.com, NEW@example.com\nrevoked@example.com', source: 'Kickstarter'});
  assert.deepEqual(result, {added: 1, skipped: 1});
  assert.equal((await db.doc('members/revoked@example.com').get()).get('active'), false);
  assert.equal((await db.doc('members/new@example.com').get()).get('source'), 'Kickstarter');
  await denied(call(owner, 'addCustomers', {emails: 'bad-email'}), 'INVALID_ARGUMENT');
  await denied(call(owner, 'setAccess', {email: owner.email, active: false}));
});
test('draft metadata stays hidden and incomplete files cannot be published', async () => {
  release = await call(owner, 'beginUpload', {...fields, filename: 'firmware.zip', size: 4, published: true});
  assert.equal((await call(customer, 'releases')).items.length, 0);
  assert.equal((await call(owner, 'releases', {admin: true})).items[0].published, false);
  await denied(call(owner, 'publish', {id: release.id, published: true}), 'FAILED_PRECONDITION');
  await denied(call(customer, 'download', {id: release.id}), 'NOT_FOUND');
});
test('large disk-image drafts preserve 64-bit sizes and enforce the upload cap', async () => {
  for (const size of [11_000_000_000, 11 * 1024 ** 3, 20 * 1024 ** 3]) {
    const draft = await call(owner, 'beginUpload', {...fields, size, filename: 'WLV-01.img'});
    const record = (await db.doc(`releases/${draft.id}`).get()).data();
    assert.equal(record.size, size);
    assert.equal(record.status, 'uploading');
    assert.equal(record.published, false);
    await denied(call(owner, 'publish', {id: draft.id, published: true}), 'FAILED_PRECONDITION');
    await denied(call(customer, 'download', {id: draft.id}), 'NOT_FOUND');
    await call(owner, 'deleteDraft', {id: draft.id});
  }
  await denied(call(owner, 'beginUpload', {...fields, size: 20 * 1024 ** 3 + 1, filename: 'too-large.img'}), 'INVALID_ARGUMENT');
  await denied(call(customer, 'beginUpload', {...fields, size: 11 * 1024 ** 3, filename: 'unauthorized.img'}));
});
test('storage enforces administrator role, active membership, and declared upload size', async () => {
  const metadata = {contentType: 'application/octet-stream', cacheControl: 'private, no-store'};
  await assertFails(uploadBytes(ref(storage(customer), release.storagePath), new Uint8Array(4), metadata));
  await assertFails(uploadBytes(ref(storage(stranger, {admin: true}), release.storagePath), new Uint8Array(4), metadata));
  await assertFails(uploadBytes(ref(storage(owner, {email_verified: false}), release.storagePath), new Uint8Array(4), metadata));
  await assertFails(uploadBytes(ref(storage(owner), release.storagePath), new Uint8Array(3), metadata));
  await assertFails(uploadBytes(ref(storage(owner), release.storagePath), new Uint8Array(4), {...metadata, contentType: 'text/html'}));
  await assertSucceeds(uploadBytes(ref(storage(owner), release.storagePath), new Uint8Array([1, 2, 3, 4]), metadata));
});
test('storage denies overwrites, direct downloads, token lookup, metadata edits, and deletes', async () => {
  for (const user of [owner, customer, stranger]) {
    const file = ref(storage(user), release.storagePath);
    await assertFails(getBytes(file)); await assertFails(getMetadata(file));
    await assertFails(updateMetadata(file, {customMetadata: {firebaseStorageDownloadTokens: 'leaked'}}));
    await assertFails(deleteObject(file));
    await assertFails(uploadBytes(file, new Uint8Array(4), {contentType: 'application/octet-stream', cacheControl: 'private, no-store'}));
  }
});
test('verification removes permanent tokens and publication makes only safe metadata available', async () => {
  await call(owner, 'completeUpload', {id: release.id});
  const record = (await db.doc(`releases/${release.id}`).get()).data();
  assert.equal(record.status, 'ready'); assert(record.generation);
  const [metadata] = await getAdminStorage(admin).bucket().file(record.storagePath).getMetadata();
  assert(!metadata.metadata?.firebaseStorageDownloadTokens);
  assert.equal((await getAdminStorage(admin).bucket().file(release.storagePath).exists())[0], false, 'staging copy must be deleted');
  await call(owner, 'publish', {id: release.id, published: true});
  const published = (await call(customer, 'releases')).items[0];
  assert.equal(published.title, fields.title);
  assert.equal(published.storagePath, undefined); assert.equal(published.generation, undefined); assert.equal(published.uploadedBy, undefined);
});
test('metadata updates cannot replace a file or silently change publication', async () => {
  await call(owner, 'saveRelease', {...fields, id: release.id, title: 'Updated release', published: false, generation: 'evil', storagePath: 'elsewhere'});
  const record = (await db.doc(`releases/${release.id}`).get()).data();
  assert.equal(record.published, true); assert.equal(record.storagePath, `releases/${release.id}/payload`); assert.notEqual(record.generation, 'evil');
});
test('revocation blocks existing sessions and restore requires a new sign-in', async () => {
  await call(owner, 'setAccess', {email: customer.email, active: false});
  await denied(call(customer, 'releases')); await denied(call(customer, 'download', {id: release.id}));
  await call(owner, 'setAccess', {email: customer.email, active: true});
  await denied(call(customer, 'access'));
  const validAfter = (await db.doc(`members/${customer.email}`).get()).get('validAfter');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, validAfter - Date.now()) + 25));
  customer = await login(customer.email);
  assert.equal((await call(customer, 'access')).role, 'customer');
});
test('unpublishing blocks download requests and draft removal deletes the object', async () => {
  await denied(call(owner, 'deleteDraft', {id: release.id}), 'FAILED_PRECONDITION');
  await call(owner, 'publish', {id: release.id, published: false});
  await denied(call(customer, 'download', {id: release.id}), 'NOT_FOUND');
  await call(owner, 'deleteDraft', {id: release.id});
  assert.equal((await db.doc(`releases/${release.id}`).get()).exists, false);
  const [exists] = await getAdminStorage(admin).bucket().file(`releases/${release.id}/payload`).exists(); assert.equal(exists, false);
  assert((await call(owner, 'activity')).items.some(item => item.action === 'Draft removed'));
});
