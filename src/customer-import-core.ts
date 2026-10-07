export const MAX_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const IMPORT_BATCH_SIZE = 100;

export type CsvRow = {line: number; cells: string[]};
export type ImportEntry = {email: string; source: string};
export type ImportIssue = {line: number; value: string; message: string};
export type ImportPreview = {entries: ImportEntry[]; issues: ImportIssue[]; duplicates: number; total: number};
export type ImportBatch = {emails: string[]; source: string};
export type ImportRun = {batches: ImportBatch[]; next: number; total: number; processed: number; added: number; skipped: number; status: "ready" | "running" | "paused" | "complete"};

const isEmail = (value: string) => value.length <= 254 && /^[^\s/@,;"]+@[^\s/@,;"]+\.[^\s/@,;"]+$/.test(value);
const headerKey = (value: string) => value.toLowerCase().replace(/[^a-z]/g, "");

function delimiter(text: string): string {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    }
    if (!quoted && (char === "\r" || char === "\n")) break;
    if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

/** Parse quoted CSV, including spreadsheet BOMs, CRLF, escaped quotes, and multiline fields. */
export function parseCsv(input: string): CsvRow[] {
  if (new TextEncoder().encode(input).length > MAX_IMPORT_BYTES) throw new Error("Choose a CSV file smaller than 10 MB.");
  const text = input.replace(/^\uFEFF/, "");
  const separator = delimiter(text);
  const rows: CsvRow[] = [];
  let cells: string[] = [], field = "", quoted = false, closed = false, line = 1, rowLine = 1;
  const finishCell = () => {
    cells.push(field); field = ""; closed = false;
    if (cells.length > 200) throw new Error("This file has more than 200 columns. Export just the email and purchase source columns.");
  };
  const finishRow = () => {
    finishCell();
    if (cells.some(cell => cell.trim())) rows.push({line: rowLine, cells});
    cells = [];
    if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error("Import up to 10,000 customers at a time. Split this file into smaller lists.");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        field += "\n"; line++;
      } else field += char;
    } else if (char === separator) finishCell();
    else if (char === "\r" || char === "\n") {
      finishRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
      line++; rowLine = line;
    } else if (char === '"') {
      if (field.trim() || closed) throw new Error(`Unexpected quote on line ${line}. Save the list as a CSV and try again.`);
      field = ""; quoted = true;
    } else if (closed && !/\s/.test(char)) throw new Error(`Check the CSV formatting on line ${line}.`);
    else if (!closed) field += char;
  }
  if (quoted) throw new Error(`An unfinished quoted value starts near line ${rowLine}. Fix the CSV and try again.`);
  finishRow();
  if (!rows.length) throw new Error("This file is empty. Choose a file with customer emails.");
  return rows;
}

export function inferColumns(rows: CsvRow[]) {
  const first = rows[0]?.cells ?? [];
  const emailColumn = first.findIndex(cell => ["email", "emailaddress", "customeremail", "customeremailaddress", "backeremail", "backeremailaddress"].includes(headerKey(cell)));
  const dataEmail = first.findIndex(cell => isEmail(cell.trim().toLowerCase()));
  const hasHeader = emailColumn >= 0 || dataEmail < 0;
  const sourceColumn = hasHeader ? first.findIndex(cell => ["source", "purchasesource", "saleschannel", "channel"].includes(headerKey(cell))) : -1;
  return {hasHeader, emailColumn: hasHeader ? emailColumn : dataEmail, sourceColumn};
}

function validateRows(rows: {line: number; value: string; source: string}[]): ImportPreview {
  if (rows.length > MAX_IMPORT_ROWS) throw new Error("Import up to 10,000 customers at a time. Split this list into smaller files.");
  if (!rows.length) throw new Error("Add at least one customer email.");
  const entries: ImportEntry[] = [], issues: ImportIssue[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const email = row.value.trim().toLowerCase(), source = row.source.trim();
    if (!isEmail(email)) { issues.push({line: row.line, value: row.value, message: "Missing or invalid email address"}); continue; }
    if (source.length > 120) { issues.push({line: row.line, value: row.value, message: "Purchase source is longer than 120 characters"}); continue; }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email); entries.push({email, source});
  }
  return {entries, issues, duplicates, total: rows.length};
}

export function previewCsv(rows: CsvRow[], emailColumn: number, sourceColumn: number, hasHeader: boolean, fallbackSource: string): ImportPreview {
  if (!Number.isInteger(emailColumn) || emailColumn < 0) throw new Error("Choose the column containing customer email addresses.");
  if (emailColumn === sourceColumn) throw new Error("Choose a different purchase source column, or use one source for the whole list.");
  return validateRows(rows.slice(hasHeader ? 1 : 0).map(row => ({line: row.line, value: row.cells[emailColumn] ?? "", source: (sourceColumn >= 0 ? row.cells[sourceColumn]?.trim() : "") || fallbackSource})));
}

export function previewPasted(input: string, source: string): ImportPreview {
  if (new TextEncoder().encode(input).length > MAX_IMPORT_BYTES) throw new Error("Paste a list smaller than 10 MB.");
  const rows = input.split(/\r\n|\n|\r/).flatMap((line, index) => line.split(/[\s,;]+/).filter(Boolean).map(value => ({line: index + 1, value, source})));
  return validateRows(rows);
}

/** Keep every request within the existing server limit and preserve each purchase source. */
export function createImportRun(entries: ImportEntry[]): ImportRun {
  if (!entries.length || entries.length > MAX_IMPORT_ROWS) throw new Error("Review a list of 1 to 10,000 customers before importing.");
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const group = groups.get(entry.source) ?? [];
    group.push(entry.email); groups.set(entry.source, group);
  }
  const batches: ImportBatch[] = [];
  for (const [source, emails] of groups) for (let i = 0; i < emails.length; i += IMPORT_BATCH_SIZE) batches.push({source, emails: emails.slice(i, i + IMPORT_BATCH_SIZE)});
  return {batches, next: 0, total: entries.length, processed: 0, added: 0, skipped: 0, status: "ready"};
}

export async function runImport(run: ImportRun, send: (batch: ImportBatch) => Promise<{added: number; skipped: number}>, progress: (run: ImportRun) => void, shouldPause = () => false): Promise<void> {
  if (run.status === "running") throw new Error("This import is already running.");
  run.status = "running"; progress(run);
  try {
    while (run.next < run.batches.length) {
      if (shouldPause()) { run.status = "paused"; progress(run); return; }
      const batch = run.batches[run.next];
      const result = await send(batch);
      if (!Number.isInteger(result.added) || !Number.isInteger(result.skipped) || result.added < 0 || result.skipped < 0 || result.added + result.skipped !== batch.emails.length) throw new Error("The import response could not be confirmed. Resume to safely check those addresses again.");
      run.added += result.added; run.skipped += result.skipped;
      run.processed += batch.emails.length; run.next++; progress(run);
    }
    run.status = "complete"; progress(run);
  } catch (error) { run.status = "paused"; progress(run); throw error; }
}

export function issuesCsv(issues: ImportIssue[]): string {
  const cell = (value: string | number) => {
    const raw = String(value);
    const safe = /^[\s]*[=+\-@]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return "\uFEFF" + [["Line", "Value", "Issue"], ...issues.map(issue => [issue.line, issue.value, issue.message])].map(row => row.map(cell).join(",")).join("\r\n");
}
