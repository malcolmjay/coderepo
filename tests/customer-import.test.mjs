import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Exercise the same dependency-free parser and batch runner used by the browser.
const compiled = ts.transpileModule(readFileSync(new URL('../src/customer-import-core.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
}).outputText;
const {parseCsv, inferColumns, previewCsv, previewPasted, createImportRun, runImport, issuesCsv, MAX_IMPORT_ROWS, MAX_IMPORT_BYTES} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const list = (count, source = 'Shopify') => Array.from({length: count}, (_, i) => ({email: `customer${i}@example.com`, source}));

test('CSV handles spreadsheet BOMs, quoted commas, escaped quotes, multiline fields, and original line numbers', () => {
  const rows = parseCsv('\uFEFFName,Email Address,Purchase Source\r\n"Smith, Alex", ALEX@EXAMPLE.COM ,"Kickstarter, \"\"round one\"\"\r\nexport"\r\n\r\nSam,sam@example.com,\r\n');
  const columns = inferColumns(rows);
  assert.deepEqual(columns, {hasHeader: true, emailColumn: 1, sourceColumn: 2});
  assert.deepEqual(rows.map(row => row.line), [1, 2, 5]);
  assert.deepEqual(previewCsv(rows, 1, 2, true, 'Direct').entries, [
    {email: 'alex@example.com', source: 'Kickstarter, "round one"\nexport'},
    {email: 'sam@example.com', source: 'Direct'},
  ]);
});

test('semicolon, TSV, and headerless exports can map email columns and a shared source', () => {
  for (const separator of [';', '\t']) {
    const rows = parseCsv(`Name${separator}Email${separator}Source\nAlex${separator}alex@example.com${separator}Etsy`);
    assert.equal(inferColumns(rows).emailColumn, 1);
    assert.deepEqual(previewCsv(rows, 1, 2, true, '').entries, [{email: 'alex@example.com', source: 'Etsy'}]);
  }
  const rows = parseCsv('Alex,alex@example.com\nSam,sam@example.com');
  assert.deepEqual(inferColumns(rows), {hasHeader: false, emailColumn: 1, sourceColumn: -1});
  assert.equal(previewCsv(rows, 1, -1, false, ' Direct ').entries[0].source, 'Direct');
  assert.throws(() => previewCsv(rows, -1, -1, false, ''), /Choose the column/);
  assert.throws(() => previewCsv(rows, 1, 1, false, ''), /different purchase source/);
});

test('review normalizes and deduplicates emails, preserves aliases, and identifies invalid rows', () => {
  const rows = parseCsv('email,source\nALEX@example.com,Etsy\n alex@example.com ,Other\nalex+one@example.com,\na.lex@example.com,\ninvalid,\n,Missing\nlong@example.com,' + 'x'.repeat(121));
  const preview = previewCsv(rows, 0, 1, true, 'Direct');
  assert.equal(preview.total, 7);
  assert.equal(preview.duplicates, 1);
  assert.deepEqual(preview.entries, [
    {email: 'alex@example.com', source: 'Etsy'},
    {email: 'alex+one@example.com', source: 'Direct'},
    {email: 'a.lex@example.com', source: 'Direct'},
  ]);
  assert.deepEqual(preview.issues.map(issue => issue.line), [6, 7, 8]);
  assert.match(preview.issues[2].message, /120/);
  const pasted = previewPasted('ALEX@example.com;sam@example.com,alex@example.com\ninvalid\n third@example.com ', 'Direct');
  assert.equal(pasted.entries.length, 3);
  assert.equal(pasted.duplicates, 1);
  assert.deepEqual(pasted.issues, [{line: 2, value: 'invalid', message: 'Missing or invalid email address'}]);
});

test('malformed, empty, oversized, and overly wide files fail before any import', () => {
  assert.throws(() => parseCsv('email,source\na@example.com,"unfinished'), /unfinished quoted/);
  assert.throws(() => parseCsv('email,source\na@example.com,"closed"oops'), /formatting/);
  assert.throws(() => parseCsv('email\na"b@example.com'), /Unexpected quote/);
  assert.throws(() => parseCsv('\n\r\n  '), /empty/);
  assert.throws(() => previewPasted(' , ;\n', ''), /at least one/);
  assert.throws(() => parseCsv('x'.repeat(MAX_IMPORT_BYTES + 1)), /10 MB/);
  assert.throws(() => parseCsv(Array(201).fill('column').join(',')), /200 columns/);
});

test('10,000-customer imports are accepted and larger lists are rejected', () => {
  const text = list(MAX_IMPORT_ROWS).map(entry => entry.email).join('\n');
  assert.equal(previewPasted(text, '').entries.length, MAX_IMPORT_ROWS);
  assert.equal(previewCsv(parseCsv('email\n' + text), 0, -1, true, '').entries.length, MAX_IMPORT_ROWS);
  assert.throws(() => previewPasted(text + '\nextra@example.com', ''), /10,000/);
  assert.throws(() => previewCsv(parseCsv(text + '\nextra@example.com'), 0, -1, false, ''), /10,000/);
  assert.throws(() => parseCsv('email\n' + text + '\nextra@example.com'), /10,000/);
});

test('250 customers run in three server-sized requests and existing records stay unchanged', async () => {
  const existing = {role: 'customer', active: false, source: 'Original purchase'};
  const records = new Map([['customer0@example.com', existing]]);
  const requests = [];
  const run = createImportRun(list(250));
  await runImport(run, async batch => {
    requests.push(batch.emails.length);
    let added = 0;
    for (const email of batch.emails) if (!records.has(email)) {records.set(email, {role: 'customer', active: true, source: batch.source}); added++;}
    return {added, skipped: batch.emails.length - added};
  }, () => {});
  assert.deepEqual(requests, [100, 100, 50]);
  assert.equal(run.status, 'complete');
  assert.equal(run.processed, 250);
  assert.equal(run.added, 249);
  assert.equal(run.skipped, 1);
  assert.equal(records.get('customer0@example.com'), existing);
});

test('mixed purchase sources are preserved while each request stays within 100 emails', () => {
  const entries = list(251).map((entry, i) => ({...entry, source: i % 2 ? 'Etsy' : 'Kickstarter'}));
  const run = createImportRun(entries);
  assert.deepEqual(run.batches.map(batch => [batch.source, batch.emails.length]), [['Kickstarter', 100], ['Kickstarter', 26], ['Etsy', 100], ['Etsy', 25]]);
  const reconstructed = new Map(run.batches.flatMap(batch => batch.emails.map(email => [email, batch.source])));
  for (const entry of entries) assert.equal(reconstructed.get(entry.email), entry.source);
});

test('an interrupted import resumes at the unconfirmed batch, safely including a lost success response', async () => {
  const records = new Set();
  const requests = [];
  let loseResponse = true;
  const send = async batch => {
    requests.push(batch.emails[0]);
    let added = 0;
    for (const email of batch.emails) if (!records.has(email)) {records.add(email); added++;}
    if (batch.emails[0] === 'customer100@example.com' && loseResponse) {loseResponse = false; throw new Error('Connection lost');}
    return {added, skipped: batch.emails.length - added};
  };
  const run = createImportRun(list(250));
  await assert.rejects(runImport(run, send, () => {}), /Connection lost/);
  assert.equal(run.status, 'paused');
  assert.equal(run.processed, 100);
  assert.equal(run.next, 1);
  await runImport(run, send, () => {});
  assert.deepEqual(requests, ['customer0@example.com', 'customer100@example.com', 'customer100@example.com', 'customer200@example.com']);
  assert.equal(records.size, 250);
  assert.equal(run.status, 'complete');
  assert.equal(run.processed, 250);
  assert.equal(run.added + run.skipped, 250);
});

test('pause stops between requests, resume continues, and an invalid response cannot advance progress', async () => {
  const run = createImportRun(list(250));
  let calls = 0;
  const send = async batch => {calls++; return {added: batch.emails.length, skipped: 0};};
  await runImport(run, send, () => {}, () => calls === 1);
  assert.equal(run.status, 'paused');
  assert.equal(run.processed, 100);
  await assert.rejects(runImport(run, async () => ({added: 1, skipped: 0}), () => {}), /could not be confirmed/);
  assert.equal(run.processed, 100);
  await runImport(run, send, () => {});
  assert.equal(run.status, 'complete');
  assert.equal(calls, 3);
  assert.equal(run.added, 250);
});

test('row issue exports escape CSV values and neutralize spreadsheet formulas', () => {
  const report = issuesCsv([{line: 2, value: '=HYPERLINK("evil")', message: 'Invalid, correct it'}, {line: 3, value: '  +formula', message: 'Invalid'}]);
  assert(report.startsWith('\uFEFF'));
  const rows = parseCsv(report);
  assert.deepEqual(rows[1].cells, ['2', '\'=HYPERLINK("evil")', 'Invalid, correct it']);
  assert.equal(rows[2].cells[1], "'  +formula");
});
