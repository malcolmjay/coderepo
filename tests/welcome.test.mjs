import {test} from 'node:test';
import assert from 'node:assert/strict';
import {welcomeMessage, WELCOME_PORTAL_URL} from '../functions/lib/welcome-template.js';
import {parseWelcomeConfig} from '../functions/lib/welcome-config.js';
import {welcomeSummary, WELCOME_LEASE_MS} from '../functions/lib/welcome-service.js';
import {smtpWelcomeSender} from '../functions/lib/welcome-smtp.js';

const config = {host: 'smtp.example.com', port: 587, user: 'smtp-user', password: 'test-password', from: 'welcome@example.com', replyTo: 'help@example.com'};

test('welcome has a stable portal CTA, personalized sign-in steps, community links, and a plain-text alternative', () => {
  const message = welcomeMessage(' Builder@Example.com ');
  for (const body of [message.text, message.html]) {
    assert(body.includes(WELCOME_PORTAL_URL));
    assert(body.includes('builder@example.com'));
    assert(body.includes('Community Builds'));
    assert(body.includes('Enhancement Requests'));
    assert(body.includes('Malcolm'));
    assert(!/oobCode|apiKey|signedUrl|<script|<img|<form/i.test(body));
  }
  assert(message.html.includes('lang="en"'));
  assert(message.text.includes('No password needed'));
});
test('recipient markup is escaped and invalid recipient inputs fail', () => {
  assert(welcomeMessage('a&b@example.com').html.includes('a&amp;b@example.com'));
  for (const value of ['bad', 'one@example.com\r\nBcc:two@example.com', null]) assert.throws(() => welcomeMessage(value));
});
test('sender configuration requires one mailbox, credentials, and an encrypted SMTP port', () => {
  assert.deepEqual(parseWelcomeConfig(JSON.stringify(config)), config);
  assert.equal(parseWelcomeConfig('{"enabled":false}'), null);
  for (const raw of ['oops', 'null', '[]', '{}', JSON.stringify({...config, port: 25}), JSON.stringify({...config, password: ''}),
    JSON.stringify({...config, host: 'smtp://host'}), JSON.stringify({...config, from: 'a@example.com,b@example.com'}),
    JSON.stringify({...config, replyTo: 'Name <a@example.com>'}), JSON.stringify({...config, from: 'a@example.com\r\nBcc:b@example.com'})]) {
    assert.throws(() => parseWelcomeConfig(raw));
  }
});
test('status exposes only delivery information and permits deliberate recovery after a stale claim', () => {
  const data = {status: 'sending', revision: 2, updatedAt: 1000, claim: 'private-claim', password: 'secret', attempts: 3};
  assert.equal(welcomeSummary(data, 2000).canRetry, false);
  const stale = welcomeSummary(data, 1000 + WELCOME_LEASE_MS);
  assert.equal(stale.status, 'uncertain'); assert.equal(stale.canRetry, true);
  assert.equal(stale.claim, undefined); assert.equal(stale.password, undefined);
  assert.equal(welcomeSummary({...data, status: 'sent'}).canRetry, false);
  assert.equal(welcomeSummary({...data, status: 'queued'}, 2000).canRetry, false);
  assert.equal(welcomeSummary({...data, status: 'queued'}, 1000 + WELCOME_LEASE_MS).canRetry, true);
  assert.equal(welcomeSummary(undefined), null);
});
test('SMTP delivery uses one recipient, TLS, a stable message ID, and disables remote content and credential logging', async () => {
  let transportOptions, sent, closed = false;
  const transportFactory = options => {transportOptions = options; return {
    sendMail: async message => {sent = message; return {accepted: ['builder@example.com']};},
    close: () => {closed = true;},
  };};
  await smtpWelcomeSender(() => JSON.stringify(config), transportFactory)({to: 'builder@example.com', id: 'stable-id', ...welcomeMessage('builder@example.com')});
  assert.equal(transportOptions.requireTLS, true); assert.equal(transportOptions.tls.rejectUnauthorized, true);
  assert.equal(transportOptions.disableFileAccess, true); assert.equal(transportOptions.disableUrlAccess, true);
  assert.equal(transportOptions.logger, false); assert.equal(transportOptions.debug, false);
  assert.deepEqual(sent.envelope, {from: 'welcome@example.com', to: ['builder@example.com']});
  assert.equal(sent.messageId, '<welcome-stable-id@example.com>'); assert.equal(sent.bcc, undefined);
  assert.equal(sent.replyTo, config.replyTo); assert.equal(closed, true);
});
test('SMTP setup, rejection, and ambiguous timeout errors are sanitized and distinguished', async () => {
  const message = {to: 'builder@example.com', id: 'id', ...welcomeMessage('builder@example.com')};
  await assert.rejects(smtpWelcomeSender(() => '{}')(message), error => error.reason === 'setup');
  await assert.rejects(smtpWelcomeSender(() => '{"enabled":false}')(message), error => error.reason === 'setup');
  for (const [failure, reason] of [[{responseCode: 550}, 'rejected'], [{code: 'EAUTH'}, 'rejected'], [{code: 'ETIMEDOUT'}, 'uncertain']]) {
    const transportFactory = () => ({sendMail: async () => {throw Object.assign(new Error('private-provider-response'), failure);}, close() {}});
    await assert.rejects(smtpWelcomeSender(() => JSON.stringify(config), transportFactory)(message), error => error.reason === reason && !error.message.includes('private-provider-response'));
  }
});
