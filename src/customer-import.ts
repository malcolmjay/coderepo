import {createImportRun, inferColumns, issuesCsv, MAX_IMPORT_BYTES, parseCsv, previewCsv, previewPasted, runImport, type CsvRow, type ImportBatch, type ImportPreview, type ImportRun} from "./customer-import-core";

type ImportOptions = {
  send: (batch: ImportBatch) => Promise<{added: number; skipped: number}>;
  busy: (value: boolean) => void;
  complete: () => Promise<void>;
  error: (error: unknown) => string;
};
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));
const number = (value: number) => value.toLocaleString();
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], {type: "text/csv;charset=utf-8"}));
  const link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountCustomerImport(host: HTMLElement, options: ImportOptions) {
  let rows: CsvRow[] | null = null, preview: ImportPreview | null = null, run: ImportRun | null = null;
  let pause = false, reading = false, pending = false, fileVersion = 0;
  host.innerHTML = `<section class="panel import-panel"><div class="row"><div><p class="eyebrow">BULK CUSTOMER IMPORT</p><h2>Give your customers access.</h2><p>Upload a CSV or paste up to 10,000 emails. Review the list, then grant access in one import.</p></div><button type="button" id="import-template" class="button secondary">Download CSV template</button></div><form id="customer-import-form" class="stack"><fieldset id="import-fields"><div class="import-grid"><p><label for="import-file">Upload a customer list</label><input id="import-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"><span class="helptext" id="import-file-help">CSV, TSV, or text · up to 10 MB. Export Excel files as CSV.</span></p><p><label for="import-emails">Or paste email addresses</label><textarea id="import-emails" rows="4" placeholder="alex@example.com&#10;sam@example.com"></textarea><span class="helptext">One email per line, or separated by commas or semicolons.</span></p></div><div id="import-columns" hidden><label class="import-checkbox"><input id="import-header" type="checkbox">First row contains column names</label><div class="form-grid"><p><label for="import-email-column">Email column</label><select id="import-email-column"></select></p><p><label for="import-source-column">Purchase source column</label><select id="import-source-column"></select></p></div></div><p><label for="import-source">Purchase source <span class="source-label">(optional)</span></label><input id="import-source" maxlength="120" placeholder="Shopify, Kickstarter, direct sale…"><span class="helptext">Used when the list does not provide a purchase source.</span></p></fieldset><div class="import-actions"><button id="import-review" class="button" type="submit">Review customer list</button><span class="fine">Existing entries keep their access settings. No emails are sent.</span></div></form><p id="import-error" class="notice error" role="alert" hidden></p><div id="import-preview" hidden></div><div id="import-result" aria-live="polite" hidden></div></section>`;
  const get = <T extends HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!;
  const form = get<HTMLFormElement>("customer-import-form"), file = get<HTMLInputElement>("import-file"), pasted = get<HTMLTextAreaElement>("import-emails"), source = get<HTMLInputElement>("import-source");
  const fields = get<HTMLFieldSetElement>("import-fields"), review = get<HTMLButtonElement>("import-review"), header = get<HTMLInputElement>("import-header");
  const emailColumn = get<HTMLSelectElement>("import-email-column"), sourceColumn = get<HTMLSelectElement>("import-source-column");
  const error = get("import-error"), previewHost = get("import-preview"), resultHost = get("import-result");
  const clearError = () => {error.hidden = true; error.textContent = "";};
  const showError = (message: string) => {error.textContent = message; error.hidden = false;};
  const invalidate = () => {preview = null; run = null; previewHost.hidden = true; resultHost.hidden = true; clearError();};

  function columns(email = -1, purchaseSource = -1) {
    if (!rows) return;
    const count = Math.max(...rows.map(row => row.cells.length));
    const labels = Array.from({length: count}, (_, i) => header.checked ? rows![0].cells[i]?.trim() || `Column ${i + 1}` : `Column ${i + 1} — ${rows![0].cells[i] ?? ""}`);
    const choices = labels.map((label, i) => `<option value="${i}">${esc(label.slice(0, 80))}</option>`).join("");
    emailColumn.innerHTML = '<option value="-1">Choose the email column…</option>' + choices;
    sourceColumn.innerHTML = '<option value="-1">Use one source for the whole list</option>' + choices;
    emailColumn.value = String(email); sourceColumn.value = String(purchaseSource);
  }

  file.addEventListener("change", async () => {
    const version = ++fileVersion; invalidate(); rows = null; get("import-columns").hidden = true;
    reading = false; review.disabled = false;
    get("import-file-help").textContent = "CSV, TSV, or text · up to 10 MB. Export Excel files as CSV.";
    const selected = file.files?.[0]; if (!selected) return;
    pasted.value = "";
    if (selected.size > MAX_IMPORT_BYTES) {showError("Choose a customer list smaller than 10 MB."); file.value = ""; return;}
    if (!/\.(csv|tsv|txt)$/i.test(selected.name)) {showError("Save your spreadsheet as CSV, then choose that file."); file.value = ""; return;}
    reading = true; review.disabled = true;
    try {
      const text = await selected.text(); if (version !== fileVersion) return;
      rows = parseCsv(text);
      const inferred = inferColumns(rows); header.checked = inferred.hasHeader;
      columns(inferred.emailColumn, inferred.sourceColumn); get("import-columns").hidden = false;
      get("import-file-help").textContent = `${selected.name} · ${number(rows.length - (header.checked ? 1 : 0))} rows found. Choose the columns to import.`;
    } catch (failure) {if (version === fileVersion) {file.value = ""; showError(failure instanceof Error ? failure.message : "Could not read this file.");}}
    finally {if (version === fileVersion) {reading = false; review.disabled = false;}}
  });
  pasted.addEventListener("input", () => {fileVersion++; reading = false; review.disabled = false; rows = null; file.value = ""; get("import-columns").hidden = true; get("import-file-help").textContent = "CSV, TSV, or text · up to 10 MB. Export Excel files as CSV."; invalidate();});
  source.addEventListener("input", invalidate);
  emailColumn.addEventListener("change", invalidate); sourceColumn.addEventListener("change", invalidate);
  header.addEventListener("change", () => {invalidate(); columns(Number(emailColumn.value), Number(sourceColumn.value));});
  get("import-template").addEventListener("click", () => download("Camera_Hacks_Customer_Import_Template.csv", "email,source\r\nalex@example.com,Shopify\r\nsam@example.com,Kickstarter\r\n"));

  function progress() {
    if (!run) return;
    const active = run.status === "running", complete = run.status === "complete";
    resultHost.hidden = false;
    resultHost.innerHTML = `<div class="import-progress-heading"><strong>${complete ? "Import complete." : active ? "Importing customers…" : "Import paused."}</strong><span>${number(run.processed)} / ${number(run.total)}</span></div><progress aria-label="Customer import progress" max="${run.total}" value="${run.processed}"></progress><p class="fine">${number(run.added)} added · ${number(run.skipped)} existing entries left unchanged${preview?.issues.length ? ` · ${number(preview.issues.length)} invalid rows excluded` : ""}</p><div class="import-actions">${active ? '<button type="button" id="import-pause" class="button secondary">Pause import</button><span class="fine">Keep this page open while the import runs.</span>' : complete ? '<button type="button" id="import-again" class="button secondary">Import another list</button>' : '<button type="button" id="import-resume" class="button">Resume import</button><button type="button" id="import-again" class="button secondary">Start another list</button>'}</div>`;
    get("import-pause")?.addEventListener("click", () => {pause = true; const button = get<HTMLButtonElement>("import-pause"); button.disabled = true; button.textContent = "Pausing…";});
    get("import-resume")?.addEventListener("click", () => {void start();});
    const again = get<HTMLButtonElement>("import-again");
    if (again) again.disabled = pending;
    again?.addEventListener("click", () => {if (pending) return; form.reset(); rows = null; fields.disabled = false; review.hidden = false; get("import-columns").hidden = true; get("import-file-help").textContent = "CSV, TSV, or text · up to 10 MB. Export Excel files as CSV."; invalidate(); pasted.focus();});
  }

  async function start() {
    if (pending || !preview?.entries.length || run?.status === "running" || run?.status === "complete") return;
    run ??= createImportRun(preview.entries);
    pause = false; clearError(); fields.disabled = true; review.hidden = true;
    get<HTMLButtonElement>("import-start")!.disabled = true;
    pending = true; options.busy(true);
    try {
      await runImport(run, options.send, progress, () => pause);
      if (run.status === "complete") {try {await options.complete();} catch {showError("Import completed. Refresh the customer list to see the latest entries.");}}
    } catch (failure) {
      const message = failure && typeof failure === "object" && "code" in failure ? options.error(failure) : failure instanceof Error ? failure.message : "The connection was interrupted.";
      showError(`${message} Completed entries are saved. Resume the import to continue; existing access settings will be preserved.`);
    } finally {pending = false; options.busy(false); progress();}
  }

  form.addEventListener("submit", event => {
    event.preventDefault(); if (reading || run) return;
    clearError();
    try {
      preview = rows ? previewCsv(rows, Number(emailColumn.value), Number(sourceColumn.value), header.checked, source.value) : previewPasted(pasted.value, source.value);
      run = null; resultHost.hidden = true; previewHost.hidden = false;
      previewHost.innerHTML = `<div class="import-summary"><div><strong>${number(preview.entries.length)}</strong><span>Ready to import</span></div><div><strong>${number(preview.duplicates)}</strong><span>Duplicates removed</span></div><div><strong>${number(preview.issues.length)}</strong><span>Rows to correct</span></div></div>${preview.issues.length ? `<div class="import-issues"><p>${number(preview.issues.length)} invalid rows will be excluded. Correct them and review again, or import the valid customers below.</p><button id="import-issues-download" class="link-button" type="button">Download rows to correct</button><details><summary>Show row issues</summary><ul>${preview.issues.slice(0, 20).map(issue => `<li>Line ${issue.line}: ${esc(issue.message)} — ${esc(issue.value.slice(0, 120))}</li>`).join("")}</ul>${preview.issues.length > 20 ? '<p class="fine">Download the report to see all row issues.</p>' : ""}</details></div>` : ""}${preview.entries.length ? `<p class="fine">Preview of the first ${Math.min(5, preview.entries.length)} customers. Duplicates use their first valid occurrence.</p><div class="table-wrap"><table><thead><tr><th scope="col">Email</th><th scope="col">Purchase source</th></tr></thead><tbody>${preview.entries.slice(0, 5).map(entry => `<tr><td>${esc(entry.email)}</td><td>${esc(entry.source || "—")}</td></tr>`).join("")}</tbody></table></div>` : ""}<div class="import-actions"><button class="button" id="import-start" type="button" ${preview.entries.length ? "" : "disabled"}>Import ${number(preview.entries.length)} ${preview.issues.length ? "valid " : ""}customers</button><span class="fine">Approved customers can sign in and access all published files.</span></div>`;
      get("import-start").addEventListener("click", () => {void start();});
      get("import-issues-download")?.addEventListener("click", () => download("Camera_Hacks_Customer_Import_Issues.csv", issuesCsv(preview!.issues)));
    } catch (failure) {preview = null; previewHost.hidden = true; showError(failure instanceof Error ? failure.message : "Check the customer list and try again.");}
  });
}
