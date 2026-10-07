import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeApp as initializeAdmin, deleteApp as deleteAdmin} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getStorage as getAdminStorage} from 'firebase-admin/storage';
import {initializeTestEnvironment, assertFails, assertSucceeds} from '@firebase/rules-unit-testing';
import {doc, getDoc, setDoc} from 'firebase/firestore';
import {ref, uploadBytes, getBytes, getMetadata, updateMetadata, deleteObject} from 'firebase/storage';
import {DOWNLOAD_LICENSE} from '../functions/lib/download-license.js';

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
test('download API rejects missing, false, forged and outdated consent for customers and admins', async () => {
  const before = (await db.collection('activity').where('action', '==', 'Download license accepted').get()).size;
  for (const user of [customer, owner]) {
    for (const consent of [{}, {licenseAccepted: false, licenseVersion: DOWNLOAD_LICENSE.version},
      {licenseAccepted: 'true', licenseVersion: DOWNLOAD_LICENSE.version}, {licenseAccepted: true},
      {licenseAccepted: true, licenseVersion: 'old-version'}]) {
      await denied(call(user, 'download', {id: release.id, ...consent}), 'FAILED_PRECONDITION');
    }
  }
  assert.equal((await db.collection('activity').where('action', '==', 'Download license accepted').get()).size, before);
});
test('accepted license is recorded with trusted identity, wording and timestamp before IAM signing', async () => {
  const consent = {licenseAccepted: true, licenseVersion: DOWNLOAD_LICENSE.version};
  const before = Date.now();
  // Emulators have no production IAM signing identity, but consent must be
  // validated and recorded before any signed link could be issued.
  await assert.rejects(call(customer, 'download', {id: release.id, ...consent,
    uid: 'forged', email: 'forged@example.com', createdAt: 1, licenseText: 'forged'}), error => error.code === 'INTERNAL');
  const entries = await db.collection('activity').where('action', '==', 'Download license accepted').get();
  assert.equal(entries.size, 1);
  const entry = entries.docs[0].data();
  assert.equal(entry.actor, customer.email);
  assert.equal(entry.uid, customer.uid);
  assert.equal(entry.releaseId, release.id);
  assert.equal(entry.licenseVersion, DOWNLOAD_LICENSE.version);
  assert.equal(entry.licenseTitle, DOWNLOAD_LICENSE.title);
  assert.equal(entry.licenseText, DOWNLOAD_LICENSE.paragraphs.join('\n\n'));
  assert.equal(entry.agreement, DOWNLOAD_LICENSE.agreement);
  assert(entry.createdAt >= before && entry.createdAt <= Date.now());
  const context = env.authenticatedContext(customer.uid, {email: customer.email, email_verified: true});
  await assertFails(getDoc(doc(context.firestore(), 'activity', entries.docs[0].id)));
  await assertFails(setDoc(doc(context.firestore(), 'activity', entries.docs[0].id), {licenseVersion: 'forged'}));
  await denied(call(stranger, 'download', {id: release.id, ...consent}));
  await denied(call(revoked, 'download', {id: release.id, ...consent}));
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

// Community fixtures use the same real email-link/callable/Storage emulators.
const buildFields = {title: 'Compact viewfinder', authorName: 'Camera Builder', version: '1.0', kind: 'models', compatibility: 'WLV-01', notes: 'Print with the opening facing up.'};
const sharing = {sharingAccepted: true, sharingVersion: '2026-10-07'};
const binary = {contentType: 'application/octet-stream', cacheControl: 'private, no-store'};
let otherCustomer;
let community;
let replacement;

test('community requires current customer access and keeps management views private', async () => {
  otherCustomer = await login('new@example.com');
  for (const operation of ['communityBuilds', 'beginCommunityUpload', 'completeCommunityUpload', 'cancelCommunityUpload', 'saveCommunityBuild', 'publishCommunityBuild', 'deleteCommunityBuild', 'downloadCommunityBuild']) {
    await denied(call(stranger, operation, {role: 'admin'}));
    await denied(call(revoked, operation));
    await denied(call(null, operation), 'UNAUTHENTICATED');
  }
  await denied(call(customer, 'communityBuilds', {scope: 'manage', role: 'admin'}));
  assert.deepEqual((await call(customer, 'communityBuilds')).items, []);
});
test('community drafts require sharing consent and take ownership only from authenticated identity', async () => {
  const data = {...buildFields, filename: 'viewfinder.stl', size: 4};
  for (const consent of [{}, {...sharing, sharingAccepted: 'true'}, {...sharing, sharingVersion: 'old'}]) {
    await denied(call(customer, 'beginCommunityUpload', {...data, ...consent}), 'FAILED_PRECONDITION');
  }
  await denied(call(customer, 'beginCommunityUpload', {...data, ...sharing, size: 1024 ** 3 + 1}), 'INVALID_ARGUMENT');
  community = await call(customer, 'beginCommunityUpload', {...data, ...sharing, uploadedBy: owner.uid, role: 'admin', published: true});
  const record = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  assert.equal(record.uploadedBy, customer.uid); assert.equal(record.pending.uploadedBy, customer.uid); assert.equal(record.published, false);
  assert.equal((await call(customer, 'communityBuilds', {scope: 'mine'})).items[0].canManage, true);
  assert.equal((await call(otherCustomer, 'communityBuilds')).items.length, 0);
  assert.equal((await call(otherCustomer, 'communityBuilds', {scope: 'mine'})).items.length, 0);
  assert.equal((await call(owner, 'communityBuilds', {scope: 'manage'})).items[0].id, community.id);
  await denied(call(otherCustomer, 'communityBuilds', {scope: 'mine', cursor: community.id}), 'INVALID_ARGUMENT');
  await denied(call(customer, 'publishCommunityBuild', {id: community.id, published: true}), 'FAILED_PRECONDITION');
});
test('community storage requires a declared upload owned by the active uploader', async () => {
  for (const user of [otherCustomer, owner, stranger, revoked]) await assertFails(uploadBytes(ref(storage(user), community.storagePath), new Uint8Array(4), binary));
  await assertFails(uploadBytes(ref(storage(customer, {email_verified: false}), community.storagePath), new Uint8Array(4), binary));
  await assertFails(uploadBytes(ref(storage(customer), community.storagePath), new Uint8Array(3), binary));
  await assertFails(uploadBytes(ref(storage(customer), community.storagePath), new Uint8Array(4), {...binary, contentType: 'text/html'}));
  await assertFails(uploadBytes(ref(storage(customer), `community-files/${community.id}/${community.uploadId}/payload`), new Uint8Array(4), binary));
  await assertFails(uploadBytes(ref(storage(customer), `community-uploads/${community.id}/${'f'.repeat(32)}/payload`), new Uint8Array(4), binary));
  await assertSucceeds(uploadBytes(ref(storage(customer), community.storagePath), new Uint8Array([1, 2, 3, 4]), binary));
  for (const user of [customer, otherCustomer, owner]) {
    const file = ref(storage(user), community.storagePath);
    await assertFails(uploadBytes(file, new Uint8Array(4), binary));
    await assertFails(getMetadata(file)); await assertFails(getBytes(file));
    await assertFails(updateMetadata(file, {customMetadata: {firebaseStorageDownloadTokens: 'forged'}}));
    await assertFails(deleteObject(file));
  }
});
test('other customers cannot edit, replace, verify, publish, discard or delete a build', async () => {
  const data = {...buildFields, ...sharing, id: community.id, uploadId: community.uploadId, filename: 'other.zip', size: 4, published: true, uploadedBy: otherCustomer.uid, role: 'admin'};
  for (const operation of ['saveCommunityBuild', 'beginCommunityUpload', 'completeCommunityUpload', 'publishCommunityBuild', 'cancelCommunityUpload', 'deleteCommunityBuild']) {
    await denied(call(otherCustomer, operation, data));
  }
  const context = env.authenticatedContext(otherCustomer.uid, {email: otherCustomer.email, email_verified: true, role: 'admin'});
  await assertFails(getDoc(doc(context.firestore(), 'communityBuilds', community.id)));
  await assertFails(setDoc(doc(context.firestore(), 'communityBuilds', community.id), {uploadedBy: otherCustomer.uid, published: true}));
});
test('community verification strips permanent tokens and requires an explicit publish step', async () => {
  await call(customer, 'completeCommunityUpload', {id: community.id, uploadId: community.uploadId});
  await call(customer, 'completeCommunityUpload', {id: community.id, uploadId: community.uploadId});
  const record = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  assert.equal(record.status, 'ready'); assert.equal(record.pending, null); assert.equal(record.published, false);
  const [metadata] = await getAdminStorage(admin).bucket().file(record.file.storagePath).getMetadata();
  assert(!metadata.metadata?.firebaseStorageDownloadTokens); assert.equal(metadata.cacheControl, 'private, no-store');
  assert.equal((await getAdminStorage(admin).bucket().file(community.storagePath).exists())[0], false);
  await denied(call(otherCustomer, 'downloadCommunityBuild', {id: community.id, licenseAccepted: true, licenseVersion: DOWNLOAD_LICENSE.version}), 'NOT_FOUND');
  await call(customer, 'publishCommunityBuild', {id: community.id, published: true});
  const item = (await call(otherCustomer, 'communityBuilds')).items[0];
  assert.equal(item.canManage, false); assert.equal(item.pending, null); assert.equal(item.authorName, buildFields.authorName);
  for (const key of ['uploadedBy', 'email', 'storagePath', 'file', 'generation', 'retiredPaths']) assert.equal(item[key], undefined);
  for (const user of [customer, owner]) assert.equal((await call(user, 'communityBuilds')).items[0].canManage, true);
});
test('community metadata edits cannot transfer ownership or alter file identity/publication', async () => {
  const before = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  await call(customer, 'saveCommunityBuild', {...buildFields, id: community.id, title: 'Revised viewfinder', uploadedBy: otherCustomer.uid, file: {storagePath: 'elsewhere'}, published: false});
  const after = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  assert.equal(after.title, 'Revised viewfinder'); assert.equal(after.uploadedBy, customer.uid);
  assert.deepEqual(after.file, before.file); assert.equal(after.published, true);
});
test('community downloads enforce the current license and record trusted consent before signing', async () => {
  for (const user of [customer, otherCustomer, owner]) {
    for (const consent of [{}, {licenseAccepted: 'true', licenseVersion: DOWNLOAD_LICENSE.version}, {licenseAccepted: true, licenseVersion: 'old'}]) {
      await denied(call(user, 'downloadCommunityBuild', {id: community.id, ...consent}), 'FAILED_PRECONDITION');
    }
  }
  await denied(call(otherCustomer, 'downloadCommunityBuild', {id: community.id, licenseAccepted: true, licenseVersion: DOWNLOAD_LICENSE.version, uid: 'forged'}), 'INTERNAL');
  const entries = await db.collection('activity').where('action', '==', 'Community download license accepted').get();
  assert.equal(entries.size, 1); const entry = entries.docs[0].data();
  assert.equal(entry.uid, otherCustomer.uid); assert.equal(entry.actor, otherCustomer.email); assert.equal(entry.buildId, community.id);
  assert.equal(entry.licenseText, DOWNLOAD_LICENSE.paragraphs.join('\n\n'));
});
test('pending replacements preserve the previous file, and can be safely discarded', async () => {
  const original = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  replacement = await call(customer, 'beginCommunityUpload', {...buildFields, ...sharing, id: community.id, filename: 'v2.zip', size: 5});
  let record = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  assert.deepEqual(record.file, original.file); assert.equal(record.published, true);
  assert.equal((await call(otherCustomer, 'communityBuilds')).items[0].pending, null);
  await denied(call(customer, 'beginCommunityUpload', {...buildFields, ...sharing, id: community.id, filename: 'duplicate.zip', size: 5}), 'FAILED_PRECONDITION');
  await denied(call(customer, 'saveCommunityBuild', {...buildFields, id: community.id}), 'FAILED_PRECONDITION');
  await denied(call(customer, 'publishCommunityBuild', {id: community.id, published: true}), 'FAILED_PRECONDITION');
  await assertSucceeds(uploadBytes(ref(storage(customer), replacement.storagePath), new Uint8Array(5), binary));
  await call(owner, 'cancelCommunityUpload', {id: community.id, uploadId: replacement.uploadId});
  record = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  assert.deepEqual(record.file, original.file); assert.equal(record.pending, null); assert.equal(record.published, true);
  assert.equal((await getAdminStorage(admin).bucket().file(replacement.storagePath).exists())[0], false);
  await denied(call(customer, 'completeCommunityUpload', {id: community.id, uploadId: replacement.uploadId}), 'FAILED_PRECONDITION');
  await assertFails(uploadBytes(ref(storage(customer), replacement.storagePath), new Uint8Array(5), binary));
});
test('replacement gets a new immutable file, removes the old file, and returns to private review', async () => {
  const original = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  replacement = await call(customer, 'beginCommunityUpload', {...buildFields, ...sharing, id: community.id, version: '2.0', filename: 'v2.zip', size: 5});
  await assertSucceeds(uploadBytes(ref(storage(customer), replacement.storagePath), new Uint8Array(5), binary));
  await call(customer, 'completeCommunityUpload', {id: community.id, uploadId: replacement.uploadId});
  const record = (await db.doc(`communityBuilds/${community.id}`).get()).data();
  assert.notEqual(record.file.storagePath, original.file.storagePath); assert.equal(record.file.id, replacement.uploadId); assert.equal(record.version, '2.0');
  assert.equal(record.published, false); assert.equal(record.uploadedBy, customer.uid);
  assert.equal((await getAdminStorage(admin).bucket().file(original.file.storagePath).exists())[0], false);
  assert.deepEqual(record.retiredPaths, []);
  await denied(call(otherCustomer, 'downloadCommunityBuild', {id: community.id, licenseAccepted: true, licenseVersion: DOWNLOAD_LICENSE.version}), 'NOT_FOUND');
});
test('admins can edit, replace, publish and remove any community build without changing ownership', async () => {
  await call(owner, 'saveCommunityBuild', {...buildFields, id: community.id, title: 'Moderated build'});
  replacement = await call(owner, 'beginCommunityUpload', {...buildFields, ...sharing, id: community.id, filename: 'admin-fix.zip', size: 3});
  await assertFails(uploadBytes(ref(storage(customer), replacement.storagePath), new Uint8Array(3), binary));
  await assertSucceeds(uploadBytes(ref(storage(owner), replacement.storagePath), new Uint8Array(3), binary));
  await call(owner, 'completeCommunityUpload', {id: community.id, uploadId: replacement.uploadId});
  await call(owner, 'publishCommunityBuild', {id: community.id, published: true});
  assert.equal((await db.doc(`communityBuilds/${community.id}`).get()).get('uploadedBy'), customer.uid);
  await call(owner, 'publishCommunityBuild', {id: community.id, published: false});
  await call(owner, 'deleteCommunityBuild', {id: community.id});
  assert.equal((await db.doc(`communityBuilds/${community.id}`).get()).exists, false);
  assert.equal((await getAdminStorage(admin).bucket().getFiles({prefix: `community-files/${community.id}/`}))[0].length, 0);
});
test('revocation blocks a contributor from managing or uploading to an existing build', async () => {
  const pending = await call(customer, 'beginCommunityUpload', {...buildFields, ...sharing, filename: 'pending.stl', size: 4});
  await call(owner, 'setAccess', {email: customer.email, active: false});
  for (const operation of ['communityBuilds', 'completeCommunityUpload', 'cancelCommunityUpload', 'saveCommunityBuild', 'publishCommunityBuild', 'deleteCommunityBuild', 'downloadCommunityBuild']) {
    await denied(call(customer, operation, {...buildFields, id: pending.id, uploadId: pending.uploadId, published: true}));
  }
  await assertFails(uploadBytes(ref(storage(customer), pending.storagePath), new Uint8Array(4), binary));
  await call(owner, 'setAccess', {email: customer.email, active: true});
  await denied(call(customer, 'communityBuilds'));
  const validAfter = (await db.doc(`members/${customer.email}`).get()).get('validAfter');
  const oldTime = JSON.parse(Buffer.from(customer.token.split('.')[1], 'base64url')).auth_time;
  await assertFails(uploadBytes(ref(storage(customer, {auth_time: oldTime}), pending.storagePath), new Uint8Array(4), binary));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, validAfter - Date.now()) + 25));
  customer = await login(customer.email);
  await call(customer, 'deleteCommunityBuild', {id: pending.id});
  await assertFails(uploadBytes(ref(storage(customer), pending.storagePath), new Uint8Array(4), binary));
});
test('concurrent completion and deletion cannot republish or retain the deleted build', async () => {
  const pending = await call(customer, 'beginCommunityUpload', {...buildFields, ...sharing, filename: 'race.stl', size: 4});
  await assertSucceeds(uploadBytes(ref(storage(customer), pending.storagePath), new Uint8Array(4), binary));
  const results = await Promise.allSettled([
    call(customer, 'completeCommunityUpload', {id: pending.id, uploadId: pending.uploadId}),
    call(owner, 'deleteCommunityBuild', {id: pending.id}),
  ]);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal((await db.doc(`communityBuilds/${pending.id}`).get()).exists, false);
  for (const prefix of [`community-files/${pending.id}/`, `community-uploads/${pending.id}/`]) assert.equal((await getAdminStorage(admin).bucket().getFiles({prefix}))[0].length, 0);
});

const enhancementFields = {title: 'Selectable focus peaking colours', description: 'Choose red, blue, or yellow peaking for better visibility.'};
const enhancementId = 'e'.repeat(32);
let reviewVersion = 0;

test('enhancement operations require membership and only admins may review requests', async () => {
  for (const operation of ['enhancementRequests', 'submitEnhancement', 'setEnhancementLike', 'reviewEnhancement']) {
    await denied(call(null, operation), 'UNAUTHENTICATED');
    await denied(call(stranger, operation));
    await denied(call(revoked, operation));
  }
  await denied(call(customer, 'reviewEnhancement', {id: enhancementId, status: 'Live', statusNote: 'Forged admin note', reviewVersion: 0, role: 'admin', admin: true}));
  await denied(call(customer, 'reviewEnhancement', {id: enhancementId, status: 'Live', statusNote: 'Forged admin note', reviewVersion: 0}));
});
test('new enhancements default to Pending Review and submissions are safe to retry', async () => {
  const request = {id: enhancementId, ...enhancementFields, status: 'Live', statusNote: 'Forged', likeCount: 99, createdBy: owner.uid, createdAt: 1};
  await Promise.all([call(customer, 'submitEnhancement', request), call(customer, 'submitEnhancement', request)]);
  const record = (await db.doc(`enhancementRequests/${enhancementId}`).get()).data();
  assert.equal(record.status, 'Pending Review'); assert.equal(record.statusNote, ''); assert.equal(record.likeCount, 0);
  assert.equal(record.createdBy, customer.uid); assert(record.createdAt > 1); assert.equal(record.reviewVersion, 0);
  assert.equal((await db.collection('activity').where('action', '==', 'Enhancement submitted').get()).size, 1);
  await denied(call(otherCustomer, 'submitEnhancement', {id: enhancementId, ...enhancementFields}), 'FAILED_PRECONDITION');
  await denied(call(customer, 'submitEnhancement', {id: enhancementId, ...enhancementFields, title: 'Changed after submission'}), 'FAILED_PRECONDITION');
});
test('enhancement listings reveal status and counts without exposing customer or liker identities', async () => {
  const mine = (await call(customer, 'enhancementRequests')).items[0];
  const other = (await call(otherCustomer, 'enhancementRequests')).items[0];
  assert.equal(mine.mine, true); assert.equal(other.mine, false); assert.equal(other.status, 'Pending Review'); assert.equal(other.liked, false);
  for (const key of ['createdBy', 'email', 'uid', 'likes', 'likerEmails']) assert.equal(other[key], undefined);
  await denied(call(customer, 'enhancementRequests', {sort: 'unsafe-field'}), 'INVALID_ARGUMENT');
  await denied(call(customer, 'enhancementRequests', {cursor: '../private'}), 'INVALID_ARGUMENT');
});
test('likes are one per authenticated account, idempotent, and can be removed', async () => {
  const input = {id: enhancementId, liked: true, uid: owner.uid, likeCount: 500};
  const [first, retry] = await Promise.all([call(customer, 'setEnhancementLike', input), call(customer, 'setEnhancementLike', input)]);
  assert.equal(first.likeCount, 1); assert.equal(retry.likeCount, 1);
  const likes = await db.collection(`enhancementRequests/${enhancementId}/likes`).get();
  assert.equal(likes.size, 1); assert.equal(likes.docs[0].id, customer.uid);
  assert.equal((await call(customer, 'enhancementRequests')).items[0].liked, true);
  assert.equal((await call(otherCustomer, 'enhancementRequests')).items[0].liked, false);
  await Promise.all([call(otherCustomer, 'setEnhancementLike', {id: enhancementId, liked: true}), call(owner, 'setEnhancementLike', {id: enhancementId, liked: true})]);
  assert.equal((await db.doc(`enhancementRequests/${enhancementId}`).get()).get('likeCount'), 3);
  await Promise.all([call(customer, 'setEnhancementLike', {id: enhancementId, liked: false}), call(customer, 'setEnhancementLike', {id: enhancementId, liked: false})]);
  assert.equal((await db.doc(`enhancementRequests/${enhancementId}`).get()).get('likeCount'), 2);
  assert.equal((await db.collection(`enhancementRequests/${enhancementId}/likes`).get()).size, 2);
  for (const liked of [undefined, 'true', 1, null]) await denied(call(customer, 'setEnhancementLike', {id: enhancementId, liked}), 'INVALID_ARGUMENT');
  await denied(call(customer, 'setEnhancementLike', {id: '0'.repeat(32), liked: true}), 'NOT_FOUND');
});
test('administrator can use all seven statuses and replace or clear the single note', async () => {
  const statuses = ['Pending Review', 'Approved', 'Not Approved', 'Pending Development', 'In Development', 'Testing', 'Live'];
  for (const status of statuses) {
    const statusNote = `Current note for ${status}`;
    const result = await call(owner, 'reviewEnhancement', {id: enhancementId, status, statusNote, reviewVersion, createdBy: owner.uid, likeCount: 999, title: 'Forged title'});
    reviewVersion++;
    assert.equal(result.reviewVersion, reviewVersion);
    const record = (await db.doc(`enhancementRequests/${enhancementId}`).get()).data();
    assert.equal(record.status, status); assert.equal(record.statusNote, statusNote);
    assert.equal(record.createdBy, customer.uid); assert.equal(record.likeCount, 2); assert.equal(record.title, enhancementFields.title);
    const visible = (await call(otherCustomer, 'enhancementRequests')).items[0];
    assert.equal(visible.status, status); assert.equal(visible.statusNote, statusNote); assert(visible.statusUpdatedAt > 0);
  }
  await call(owner, 'reviewEnhancement', {id: enhancementId, status: 'Live', statusNote: '', reviewVersion}); reviewVersion++;
  assert.equal((await db.doc(`enhancementRequests/${enhancementId}`).get()).get('statusNote'), '');
  await denied(call(owner, 'reviewEnhancement', {id: enhancementId, status: 'Done', statusNote: '', reviewVersion}), 'INVALID_ARGUMENT');
  await denied(call(customer, 'reviewEnhancement', {id: enhancementId, status: 'Approved', statusNote: 'Attempted note', reviewVersion}));
});
test('stale admin reviews cannot overwrite a newer note, and likes do not invalidate a review', async () => {
  await denied(call(owner, 'reviewEnhancement', {id: enhancementId, status: 'Testing', statusNote: 'Stale note', reviewVersion: reviewVersion - 1}), 'FAILED_PRECONDITION');
  await call(customer, 'setEnhancementLike', {id: enhancementId, liked: true});
  await call(owner, 'reviewEnhancement', {id: enhancementId, status: 'Testing', statusNote: 'Testing with customers.', reviewVersion}); reviewVersion++;
  const record = (await db.doc(`enhancementRequests/${enhancementId}`).get()).data();
  assert.equal(record.likeCount, 3); assert.equal(record.statusNote, 'Testing with customers.');
  await call(customer, 'submitEnhancement', {id: enhancementId, ...enhancementFields});
  assert.equal((await db.doc(`enhancementRequests/${enhancementId}`).get()).get('reviewVersion'), reviewVersion, 'submission retries must not reset review state');
});
test('direct database reads and writes cannot expose likes or forge request statuses and counts', async () => {
  for (const user of [customer, otherCustomer, owner]) {
    const context = env.authenticatedContext(user.uid, {email: user.email, email_verified: true, admin: true});
    for (const path of [`enhancementRequests/${enhancementId}`, `enhancementRequests/${enhancementId}/likes/${customer.uid}`]) {
      await assertFails(getDoc(doc(context.firestore(), path)));
      await assertFails(setDoc(doc(context.firestore(), path), {status: 'Live', likeCount: 5000, statusNote: 'Forged'}));
    }
  }
});
test('enhancement pagination supports newest and most-liked ordering with bounded pages', async () => {
  const batch = db.batch();
  const ids = Array.from({length: 55}, (_, i) => i.toString(16).padStart(32, 'a'));
  ids.forEach((id, i) => batch.create(db.doc(`enhancementRequests/${id}`), {...enhancementFields, createdBy: otherCustomer.uid, status: 'Pending Review', statusNote: '', statusUpdatedAt: null, reviewVersion: 0, likeCount: i, createdAt: Date.now() + i + 10000}));
  await batch.commit();
  for (const sort of ['newest', 'popular']) {
    const first = await call(customer, 'enhancementRequests', {sort});
    assert.equal(first.items.length, 50); assert(first.next);
    const second = await call(customer, 'enhancementRequests', {sort, cursor: first.next});
    assert.equal(second.items.length, 6); assert.equal(second.next, null);
    const all = first.items.concat(second.items);
    assert.equal(new Set(all.map(item => item.id)).size, 56);
    const field = sort === 'popular' ? 'likeCount' : 'createdAt';
    for (let i = 1; i < all.length; i++) assert(all[i - 1][field] >= all[i][field]);
    assert.equal(all.find(item => item.id === enhancementId).liked, true);
  }
  const remove = db.batch(); ids.forEach(id => remove.delete(db.doc(`enhancementRequests/${id}`))); await remove.commit();
});
test('revoked customers cannot submit, read, or change likes, including with an old restored session', async () => {
  await call(owner, 'setAccess', {email: customer.email, active: false});
  for (const operation of ['enhancementRequests', 'submitEnhancement', 'setEnhancementLike']) {
    await denied(call(customer, operation, {id: enhancementId, ...enhancementFields, liked: false}));
  }
  assert.equal((await db.doc(`enhancementRequests/${enhancementId}`).get()).get('likeCount'), 3);
  await call(owner, 'setAccess', {email: customer.email, active: true});
  await denied(call(customer, 'setEnhancementLike', {id: enhancementId, liked: false}));
  const validAfter = (await db.doc(`members/${customer.email}`).get()).get('validAfter');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, validAfter - Date.now()) + 25));
  customer = await login(customer.email);
  assert.equal((await call(customer, 'setEnhancementLike', {id: enhancementId, liked: false})).likeCount, 2);
});
