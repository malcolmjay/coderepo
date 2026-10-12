import {test} from 'node:test';
import assert from 'node:assert/strict';
import {welcomeSummary, WELCOME_LEASE_MS} from '../functions/lib/welcome-service.js';
import {firebaseWelcomeSender} from '../functions/lib/welcome-firebase.js';

const projectId = 'camera-hacks';
const configUrl = `https://${projectId}.web.app/__/firebase/init.json`;
const config = {apiKey: 'public-project-key', projectId};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('Firebase invitation uses the existing project sender and only a fixed sign-in request', async () => {
  const calls = [];
  const sender = firebaseWelcomeSender(projectId, async (url, options) => {
    calls.push({url, options});
    return url === configUrl ? json(config) : json({email: 'builder@example.com'});
  });
  await sender({to: ' Builder@Example.com ', html: '<b>forged</b>', from: 'forged@example.com', continueUrl: 'https://evil.example/', returnOobLink: true});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, configUrl);
  assert.equal(calls[1].url, 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=public-project-key');
  assert.deepEqual(JSON.parse(calls[1].options.body), {requestType: 'EMAIL_SIGNIN', email: 'builder@example.com', continueUrl: 'https://camera-hacks.web.app/', canHandleCodeInApp: true});
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(calls[1].options.headers, {'Content-Type': 'application/json'});
  assert.equal(calls[1].options.redirect, 'error'); assert(calls[1].options.signal instanceof AbortSignal);
  for (const forbidden of ['html', 'from', 'returnOobLink', 'idToken', 'password', 'oobCode']) assert.equal(forbidden in JSON.parse(calls[1].options.body), false);
});
test('Hosting config is cached and refreshed after a Firebase key/permission rejection', async () => {
  let reads = 0, attempts = 0;
  const keys = [];
  const sender = firebaseWelcomeSender(projectId, async url => {
    if (url === configUrl) {reads++; return json({...config, apiKey: `key-${reads}`});}
    attempts++; keys.push(new URL(url).searchParams.get('key'));
    return attempts === 2 ? json({error: {message: 'API_KEY_INVALID: private details'}}, 403) : json({});
  });
  await sender({to: 'one@example.com'});
  await assert.rejects(sender({to: 'two@example.com'}), error => error.reason === 'setup');
  await sender({to: 'two@example.com'});
  assert.equal(reads, 2); assert.deepEqual(keys, ['key-1', 'key-1', 'key-2']);
});
test('missing, foreign, malformed, and unreachable Hosting config cannot send mail', async () => {
  for (const value of [{}, {...config, projectId: 'another-project'}, {...config, apiKey: 'key&other=evil'}, {...config, apiKey: ''}]) {
    let calls = 0;
    await assert.rejects(firebaseWelcomeSender(projectId, async url => {calls++; assert.equal(url, configUrl); return json(value);})({to: 'one@example.com'}), error => error.reason === 'setup');
    assert.equal(calls, 1);
  }
  await assert.rejects(firebaseWelcomeSender(projectId, async () => {throw new Error('private failure');})({to: 'one@example.com'}), error => error.reason === 'setup' && !error.message.includes('private failure'));
});
test('unsafe project names and invalid recipients are rejected before a network request', async () => {
  for (const project of ['', '../other', 'host.example', 'https://example.com', 'BAD-UPPERCASE', 'project/other']) assert.throws(() => firebaseWelcomeSender(project));
  let requests = 0;
  const sender = firebaseWelcomeSender(projectId, async () => {requests++; return json(config);});
  for (const to of ['bad', null, 'one@example.com\r\nother@example.com']) await assert.rejects(sender({to}));
  assert.equal(requests, 0);
});
test('Firebase limits, setup errors, rejection and ambiguous server failures are sanitized', async () => {
  const cases = [[429, 'TOO_MANY_ATTEMPTS_TRY_LATER', 'quota'], [400, 'QUOTA_EXCEEDED', 'quota'], [400, 'OPERATION_NOT_ALLOWED', 'setup'],
    [400, 'UNAUTHORIZED_DOMAIN', 'setup'], [403, 'API_KEY_HTTP_REFERRER_BLOCKED', 'setup'], [400, 'INVALID_EMAIL', 'rejected'], [503, 'INTERNAL_ERROR', 'uncertain']];
  for (const [status, code, reason] of cases) {
    const sender = firebaseWelcomeSender(projectId, async url => url === configUrl ? json(config) : json({error: {message: `${code}: private token and user@example.com`}}, status));
    await assert.rejects(sender({to: 'one@example.com'}), error => error.reason === reason && !/private|user@example/.test(error.message));
  }
});
test('a lost send response remains uncertain and is never automatically submitted twice', async () => {
  let attempts = 0;
  const sender = firebaseWelcomeSender(projectId, async url => {
    if (url === configUrl) return json(config);
    attempts++; throw new Error('timeout after possible acceptance');
  });
  await assert.rejects(sender({to: 'one@example.com'}), error => error.reason === 'uncertain');
  assert.equal(attempts, 1);
});
test('status exposes only delivery information and permits deliberate recovery after a stale claim', () => {
  const data = {status: 'sending', revision: 2, updatedAt: 1000, claim: 'private-claim', accessToken: 'secret', attempts: 3};
  assert.equal(welcomeSummary(data, 2000).canRetry, false);
  const stale = welcomeSummary(data, 1000 + WELCOME_LEASE_MS);
  assert.equal(stale.status, 'uncertain'); assert.equal(stale.canRetry, true);
  assert.equal(stale.claim, undefined); assert.equal(stale.accessToken, undefined);
  assert.equal(welcomeSummary({...data, status: 'sent'}).canRetry, false);
  assert.equal(welcomeSummary({...data, status: 'queued'}, 2000).canRetry, false);
  assert.equal(welcomeSummary({...data, status: 'queued'}, 1000 + WELCOME_LEASE_MS).canRetry, true);
  assert.equal(welcomeSummary(undefined), null);
});
