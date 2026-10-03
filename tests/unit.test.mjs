import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertAccess, assertDownloadLicense, bulkEmails, email, filename, releaseFields, releaseId, uploadSize} from '../functions/lib/domain.js';
import {DOWNLOAD_LICENSE} from '../functions/lib/download-license.js';

const identity = {uid: 'customer', email: 'customer@example.com', email_verified: true, auth_time: 100};
const member = {email: identity.email, role: 'customer', active: true, validAfter: 0};
const fields = {title: 'Camera firmware', version: '1.0', kind: 'firmware', compatibility: 'WLV-01 / IMX294'};
test('canonical email preserves distinct plus aliases and rejects unsafe IDs', () => {
  assert.equal(email(' User+camera@Example.COM '), 'user+camera@example.com');
  for (const value of ['bad', 'a/b@example.com', '', 'a@b', null, 'x\n@y.com']) assert.throws(() => email(value));
});
test('authentication alone does not grant membership or administrator access', () => {
  assert.throws(() => assertAccess(undefined, member));
  assert.throws(() => assertAccess({...identity, email_verified: false}, member));
  assert.throws(() => assertAccess({...identity, auth_time: undefined}, member));
  assert.throws(() => assertAccess(identity, undefined));
  assert.throws(() => assertAccess(identity, {...member, email: 'someone@example.com'}));
  assert.throws(() => assertAccess(identity, {...member, active: false}));
  assert.throws(() => assertAccess(identity, member, true));
  assert.equal(assertAccess(identity, member), member);
});
test('restore cannot reactivate a token issued before revocation', () => {
  const restored = {...member, validAfter: 101000};
  assert.throws(() => assertAccess(identity, restored));
  assert.equal(assertAccess({...identity, auth_time: 101}, restored), restored);
});
test('bulk import deduplicates and enforces a bounded input', () => {
  assert.deepEqual(bulkEmails(' A@example.com, a@example.com; b@example.com\n'), ['a@example.com', 'b@example.com']);
  assert.throws(() => bulkEmails(''));
  assert.throws(() => bulkEmails(Array.from({length: 101}, (_, i) => `u${i}@example.com`).join('\n')));
});
test('release validation rejects invalid categories, checksums, IDs and file sizes', () => {
  assert.equal(releaseFields(fields).title, fields.title);
  assert.throws(() => releaseFields({...fields, kind: 'script'}));
  assert.throws(() => releaseFields({...fields, sha256: 'bad'}));
  assert.throws(() => releaseId('../../private'));
  for (const size of [0, -1, '1', 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER, 20 * 1024 ** 3 + 1]) assert.throws(() => uploadSize(size));
  for (const size of [1, 11_000_000_000, 11 * 1024 ** 3, 20 * 1024 ** 3]) assert.equal(uploadSize(size), size);
  assert(!/[\r\n"/\\]/.test(filename('../../evil"\r\n.zip')));
});
test('publication fields cannot be smuggled into an ordinary metadata edit', () => {
  const result = releaseFields({...fields, published: true, storagePath: 'private/other', generation: '123', role: 'admin'});
  for (const field of ['published', 'storagePath', 'generation', 'role']) assert.equal(field in result, false);
});
test('download consent must be explicit and refer to the current license', () => {
  for (const accepted of [undefined, null, false, 0, 1, 'true', {}, []]) {
    assert.throws(() => assertDownloadLicense(accepted, DOWNLOAD_LICENSE.version), error => error.code === 'failed-precondition');
  }
  for (const version of [undefined, null, '', 'old-version', 20261002]) {
    assert.throws(() => assertDownloadLicense(true, version), error => error.code === 'failed-precondition');
  }
  assert.doesNotThrow(() => assertDownloadLicense(true, DOWNLOAD_LICENSE.version));
});
