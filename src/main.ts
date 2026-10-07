import "./style.css";
import { isSignInWithEmailLink, onAuthStateChanged, sendSignInLinkToEmail, signInWithEmailLink, signOut } from "firebase/auth";
import { connect } from "./firebase";
import { mountCustomerImport } from "./customer-import";
import { uploadFile } from "./file-upload";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "../functions/src/upload-config.js";
import { DOWNLOAD_LICENSE } from "../functions/src/download-license.js";
import {communityPage} from "./community";

type Access = {email: string; role: "admin" | "customer"};
type Release = {id: string; title: string; version: string; kind: string; compatibility: string; notes: string; sha256: string; filename: string; size: number; published: boolean; status: string; publishedAt: number | null; createdAt: number};
type Customer = {email: string; source: string; role: string; active: boolean};
type Event = {id: string; actor: string; action: string; target: string; createdAt: number};
type Page<T> = {items: T[]; next: string | null};
const categories: Record<string, string> = {firmware: "Firmware", software: "Camera software", models: "3D files", guide: "Guides"};
const main = document.querySelector<HTMLElement>("#main")!;
const nav = document.querySelector<HTMLElement>("#nav")!;
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]!));
const date = (value: number | null) => value ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium"}).format(value) : "Draft";
const bytes = (size: number) => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GiB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(size / 1024)} KiB`;
const options = (selected = "", all = false) => `${all ? '<option value="">All files</option>' : ""}${Object.entries(categories).map(([key, label]) => `<option value="${key}" ${selected === key ? "selected" : ""}>${label}</option>`).join("")}`;
let session: Access | null = null;
let client: Awaited<ReturnType<typeof connect>>;
let navigating = 0;
let uploading = false;
let uploadPage = "#releases";
let importing = false;
let completing = false;
let currentReleases: Release[] = [];

function errorMessage(error: unknown) {
  const e = error as {code?: string; message?: string};
  if (e.code === "auth/invalid-action-code" || e.code === "auth/expired-action-code") return "This link has expired or was already used. Request a new sign-in link.";
  if (e.code === "auth/too-many-requests" || e.code === "functions/resource-exhausted") return "Please wait a little before trying again.";
  if (e.code === "auth/invalid-email") return "Enter a valid email address.";
  if (e.code === "auth/network-request-failed" || e.code === "functions/unavailable") return "Could not connect. Check your connection and try again.";
  if (e.code === "storage/unauthorized") return "This upload is no longer authorized. Sign in again or remove the unfinished draft and retry.";
  if (e.code === "storage/canceled") return "Upload canceled.";
  if (e.code === "storage/retry-limit-exceeded") return "The connection did not recover. Check your connection and start a new upload.";
  if (e.code?.startsWith("functions/")) return e.message || "Please try again.";
  return "Something went wrong. Please try again or contact Camera Hacks.";
}

function notice(message: string, error = false) {
  let target = document.querySelector<HTMLElement>("#notice");
  if (!target) { target = document.createElement("div"); target.id = "notice"; main.prepend(target); }
  target.className = `notice ${error ? "error" : ""}`;
  target.setAttribute("role", error ? "alert" : "status");
  target.textContent = message;
  target.scrollIntoView({block: "nearest"});
}

function busy(form: HTMLFormElement, value: boolean) {
  form.querySelectorAll<HTMLButtonElement>("button").forEach(button => {button.disabled = value;});
  form.setAttribute("aria-busy", String(value));
}

function navigation() {
  nav.innerHTML = session ? `<a href="#downloads"><span class="nav-index" aria-hidden="true">01 /</span>Downloads</a><a href="#community"><span class="nav-index" aria-hidden="true">02 /</span>Community Builds</a>${session.role === "admin" ? '<a href="#customers"><span class="nav-index" aria-hidden="true">03 /</span>Admin</a>' : ""}<button class="link-button" id="signout"><span class="nav-index" aria-hidden="true">${session.role === "admin" ? "04" : "03"} /</span>Sign out</button>` : '<span class="header-label">CUSTOMER DOWNLOADS</span>';
  document.querySelector("#signout")?.addEventListener("click", () => {void client.auth.signOut();});
}

function adminNav(active: string) {
  return `<nav class="admin-nav" aria-label="Administration">${[["customers", "Customer access"], ["releases", "Manage files"], ["activity", "Activity"]].map(([href, label]) => `<a href="#${href}" ${active === href ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

function heading(title: string, description: string, admin = true) {
  return `<section class="page-heading"><div><p class="eyebrow">${admin ? "ADMINISTRATION" : "YOUR CAMERA, ALWAYS EVOLVING"}</p><h1>${title}</h1><p>${description}</p></div>${!admin && session ? `<div class="account"><span class="status-dot"></span> Access enabled<small>${esc(session.email)}</small></div>` : ""}</section><div id="notice" aria-live="polite"></div>`;
}

function login(message = "") {
  session = null; navigation();
  main.innerHTML = `<section class="login-layout"><div class="login-intro"><p class="eyebrow">THE CAMERA HACKS DOWNLOAD LIBRARY</p><h1>A Camera designed to be <span class="text-accent">hacked.</span></h1><p class="lede">The latest software, firmware, and printable parts for your camera. All in one place.</p><div class="feature-list"><p><span>01</span> Camera software & firmware</p><p><span>02</span> 3D files & printable parts</p><p><span>03</span> Guides & release notes</p></div><p class="intro-note">For Camera Hacks customers, wherever you purchased.</p></div><div class="panel login-panel"><span class="tag">CUSTOMER ACCESS</span><h2>Welcome back.</h2><p>Enter your authorized email. We’ll send you a link to sign in—no password needed.</p><div id="notice" aria-live="polite"></div><form id="login-form" class="stack"><p><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" required></p><button class="button" type="submit">Send sign-in link <span aria-hidden="true">→</span></button></form><p class="fine">Use the email address authorized for your purchase.</p><div class="help-note"><strong>Need access?</strong><p>Contact Camera Hacks through the shop with your order details and the email you’d like to use.</p></div></div></section>`;
  if (message) notice(message, true);
  document.querySelector<HTMLFormElement>("#login-form")!.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    busy(form, true);
    const email = String(new FormData(form).get("email")).trim().toLowerCase();
    try {
      await sendSignInLinkToEmail(client.auth, email, {url: `${location.origin}/`, handleCodeInApp: true});
      try {localStorage.setItem("camera-hacks-signin-email", email);} catch { /* Cross-device form also handles unavailable storage. */ }
      notice("Check your inbox for a sign-in link. Only authorized customer emails can access the downloads.");
    } catch (error) {notice(errorMessage(error), true);} finally {busy(form, false);}
  });
}

async function finishLink() {
  completing = true;
  const link = location.href;
  // Remove the one-time token from browser history and any outgoing referrer.
  history.replaceState(null, "", "/");
  let email = "";
  try {email = localStorage.getItem("camera-hacks-signin-email") || "";} catch { /* Ask below. */ }
  main.innerHTML = `<section class="panel verify-panel"><span class="tag">EMAIL SIGN-IN</span><h1>Finish signing in.</h1><p>Confirm the email address that received this link.</p><div id="notice" aria-live="polite"></div><form id="finish-form" class="stack"><p><label for="confirm-email">Email address</label><input id="confirm-email" name="email" type="email" autocomplete="email" required value="${esc(email)}"></p><button class="button" type="submit">Sign in <span aria-hidden="true">→</span></button></form><p class="fine"><a href="/">Request a new link</a></p></section>`;
  document.querySelector<HTMLFormElement>("#finish-form")!.addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement; busy(form, true);
    try {
      await signInWithEmailLink(client.auth, String(new FormData(form).get("email")).trim().toLowerCase(), link);
      try {localStorage.removeItem("camera-hacks-signin-email");} catch { /* No-op. */ }
      completing = false;
      await loadSession();
    } catch (error) {notice(errorMessage(error), true); busy(form, false);}
  });
}

async function loadSession() {
  if (!client.auth.currentUser) {login(); return;}
  try {session = await client.api<Access>("access"); navigation(); await route();}
  catch (error) {await signOut(client.auth); login(errorMessage(error));}
}

async function download(id: string, isAccepted: () => boolean, operation = "download") {
  if (!isAccepted()) return;
  try {
    const {url} = await client.api<{url: string}>(operation, {id, licenseAccepted: true, licenseVersion: DOWNLOAD_LICENSE.version});
    if (!isAccepted()) return; // The user may uncheck or leave while the link is being prepared.
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !(parsed.hostname === "storage.googleapis.com" || parsed.hostname.endsWith(".storage.googleapis.com"))) throw new Error("Unexpected download location");
    const link = document.createElement("a"); link.href = url; link.rel = "noreferrer"; link.referrerPolicy = "no-referrer";
    document.body.append(link); link.click(); link.remove();
  } catch (error) {notice(errorMessage(error), true);}
}

function downloadLicensePanel() {
  return `<section class="panel download-license" aria-labelledby="license-title"><h2 id="license-title">${esc(DOWNLOAD_LICENSE.title)}</h2><div id="license-text">${DOWNLOAD_LICENSE.paragraphs.map(paragraph => `<p>${esc(paragraph)}</p>`).join("")}</div><label class="license-checkbox" for="download-license"><input id="download-license" type="checkbox" required aria-describedby="license-text"><span>${esc(DOWNLOAD_LICENSE.agreement)}</span></label><p id="license-requirement" class="fine" aria-live="polite">Agree to the license above to enable downloads.</p></section>`;
}

function releaseCard(release: Release, latest: boolean, admin: boolean) {
  return `<article class="release-card"><div class="file-symbol" aria-hidden="true">${release.kind === "models" ? "3D" : release.kind === "guide" ? "DOC" : "FW"}</div><div class="release-body"><div class="release-meta"><span>${esc(categories[release.kind])}</span>${admin ? `<span class="badge ${release.published ? "" : "muted"}">${release.published ? "Published" : release.status === "ready" ? "Draft" : release.status === "deleting" ? "Removal pending" : "Upload pending"}</span>` : latest ? '<span class="badge">Latest</span>' : ""}</div><h2>${esc(release.title)}</h2><p class="compatibility">${esc(release.compatibility)}</p><p class="release-details">v${esc(release.version)} <span>·</span> ${bytes(release.size)} <span>·</span> ${date(release.publishedAt)}</p><details><summary>Release notes & file details</summary><div class="release-notes">${esc(release.notes || "No release notes yet.")}</div><p class="fine">${esc(release.filename)}</p>${release.sha256 ? `<p class="fine">Publisher-provided SHA-256</p><code class="checksum">${esc(release.sha256)}</code>` : ""}</details>${admin ? `<div class="actions release-actions"><button class="link-button" data-edit="${release.id}">Edit details</button>${release.status === "ready" ? `<button class="link-button" data-publish="${release.id}" data-value="${!release.published}">${release.published ? "Unpublish" : "Publish"}</button>` : release.status === "uploading" ? `<button class="link-button" data-verify="${release.id}">Verify upload</button>` : ""}${!release.published ? `<button class="link-button danger" data-delete="${release.id}">Remove draft</button>` : ""}</div>` : ""}</div>${release.status === "ready" ? `<button class="button download-button" data-download="${release.id}" aria-label="Download ${esc(release.title)} version ${esc(release.version)}">${admin ? "Test download" : "Download"} <span aria-hidden="true">↓</span></button>` : ""}</article>`;
}

async function releasesPage(admin: boolean, token: number) {
  const first = await client.api<Page<Release>>("releases", {admin});
  if (token !== navigating) return;
  currentReleases = first.items;
  main.innerHTML = heading(admin ? "Manage files." : "Your downloads.", admin ? "Upload a release, check the details, then publish it for your customers." : "Updates, printable parts, and a little more possibility.", admin)
    + (admin ? adminNav("releases") + `<section class="panel"><div class="row"><div><h2>New release</h2><p>Files stay private until you publish them.</p></div><button id="new-release" class="button">Upload a file</button></div><div id="editor"></div></section>` : "")
    + downloadLicensePanel()
    + `<div class="filters" role="search"><label class="sr-only" for="search">Search downloads</label><input id="search" type="search" placeholder="Search by camera, sensor, or release…"><label class="sr-only" for="category">File category</label><select id="category">${options("", true)}</select></div><div class="section-label"><span>AVAILABLE FILES</span><span id="count"></span></div><div id="release-list"></div><button class="button secondary load-more" id="more" ${first.next ? "" : "hidden"}>Load more files</button><aside class="download-note"><strong>Before you update</strong><p>Check camera and sensor compatibility, follow the release instructions, and back up your photos and settings first.</p></aside>`;
  const consent = main.querySelector<HTMLInputElement>("#download-license")!;
  const releaseList = main.querySelector<HTMLElement>("#release-list")!;
  const requirement = main.querySelector<HTMLElement>("#license-requirement")!;
  const downloading = new Set<string>();
  const isAccepted = () => consent.isConnected && consent.checked;
  const updateDownloadButtons = () => {
    releaseList.querySelectorAll<HTMLButtonElement>("button[data-download]").forEach(button => {
      button.disabled = !isAccepted() || downloading.has(button.dataset.download!);
      button.setAttribute("aria-describedby", "license-requirement");
    });
    requirement.textContent = consent.checked ? "License accepted. You can now download files." : "Agree to the license above to enable downloads.";
  };
  consent.addEventListener("change", updateDownloadButtons);
  const draw = () => {
    const query = document.querySelector<HTMLInputElement>("#search")!.value.toLowerCase();
    const category = document.querySelector<HTMLSelectElement>("#category")!.value;
    const seen = new Set<string>();
    const latestIds = new Set<string>();
    for (const release of currentReleases) {
      const family = `${release.kind}:${release.title}:${release.compatibility}`;
      if (!seen.has(family)) latestIds.add(release.id);
      seen.add(family);
    }
    const filtered = currentReleases.filter(r => (!category || r.kind === category) && `${r.title} ${r.compatibility} ${r.version} ${r.notes}`.toLowerCase().includes(query));
    document.querySelector("#count")!.textContent = `${filtered.length} of ${currentReleases.length} loaded`;
    document.querySelector("#release-list")!.innerHTML = filtered.map(r => releaseCard(r, latestIds.has(r.id), admin)).join("") || `<div class="empty"><span class="empty-icon" aria-hidden="true">↓</span><h2>${query || category ? "No matching files." : "Files are on their way."}</h2><p>${query || category ? "Try another search, or load more releases below." : "Published firmware and 3D files will appear here."}</p></div>`;
    updateDownloadButtons();
  };
  draw();
  document.querySelector("#search")!.addEventListener("input", draw);
  document.querySelector("#category")!.addEventListener("change", draw);
  let cursor = first.next;
  document.querySelector("#more")!.addEventListener("click", async event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    try {const result = await client.api<Page<Release>>("releases", {admin, cursor}); currentReleases.push(...result.items); cursor = result.next; button.hidden = !cursor; draw();}
    catch (error) {notice(errorMessage(error), true);} finally {button.disabled = false;}
  });
  document.querySelector("#new-release")?.addEventListener("click", () => editor());
  document.querySelector("#release-list")!.addEventListener("click", async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!button) return;
    if (button.dataset.download) {
      const id = button.dataset.download;
      if (!isAccepted() || downloading.has(id)) return;
      downloading.add(id); updateDownloadButtons();
      try {await download(id, isAccepted);} finally {downloading.delete(id); updateDownloadButtons();}
      return;
    }
    if (button.dataset.edit) {editor(currentReleases.find(r => r.id === button.dataset.edit)); return;}
    if (button.dataset.delete && !confirm("Permanently remove this draft and its file?")) return;
    button.disabled = true;
    try {
      if (button.dataset.publish) await client.api("publish", {id: button.dataset.publish, published: button.dataset.value === "true"});
      if (button.dataset.verify) await client.api("completeUpload", {id: button.dataset.verify});
      if (button.dataset.delete) await client.api("deleteDraft", {id: button.dataset.delete});
      await route();
    } catch (error) {notice(errorMessage(error), true); button.disabled = false;}
  });
}

function editor(release?: Release) {
  if (uploading) return;
  const host = document.querySelector<HTMLElement>("#editor")!;
  host.innerHTML = `<form id="release-form" class="stack release-form"><div class="form-grid"><p><label for="title">Release title</label><input id="title" name="title" maxlength="120" value="${esc(release?.title)}" placeholder="WLV-01 camera software" required></p><p><label for="version">Version</label><input id="version" name="version" maxlength="40" value="${esc(release?.version)}" placeholder="3.2.0" required></p><p><label for="kind">Category</label><select id="kind" name="kind">${options(release?.kind || "firmware")}</select></p><p><label for="compatibility">Compatible cameras / sensors</label><input id="compatibility" name="compatibility" maxlength="200" value="${esc(release?.compatibility)}" placeholder="WLV-01 · IMX294" required></p></div><p><label for="notes">Release notes & installation instructions</label><textarea id="notes" name="notes" maxlength="10000" rows="5">${esc(release?.notes)}</textarea></p><p><label for="sha256">SHA-256 checksum (optional)</label><input id="sha256" name="sha256" maxlength="64" pattern="[a-fA-F0-9]{64}" value="${esc(release?.sha256)}"><span class="helptext">Use the checksum generated from your original release file.</span></p>${!release ? '<p><label for="file">Release file</label><input id="file" name="file" type="file" required><span class="helptext">Up to ' + MAX_UPLOAD_LABEL + '. Raw .img files are supported. Keep this tab open and your computer awake. You can pause and resume here; closing the tab requires a new upload.</span></p>' : `<p class="fine">${esc(release.filename)} · Upload a new release to replace the file.</p>`}<progress id="progress" max="100" value="0" hidden aria-label="File upload progress"></progress><p id="upload-status" role="status"></p><div id="upload-controls" class="actions upload-controls" hidden><button class="button secondary" type="button" id="pause-upload">Pause upload</button><button class="button secondary" type="button" id="cancel-upload">Cancel upload</button></div><div class="actions"><button class="button" type="submit">${release ? "Save details" : "Upload as draft"}</button><button class="button secondary" type="button" id="cancel-editor">Cancel</button></div></form>`;
  host.scrollIntoView({block: "start", behavior: "smooth"});
  document.querySelector("#cancel-editor")!.addEventListener("click", () => {if (!uploading) host.innerHTML = "";});
  document.querySelector<HTMLFormElement>("#release-form")!.addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form);
    const fields = Object.fromEntries([...data.entries()].filter(([key]) => key !== "file"));
    busy(form, true);
    try {
      if (release) await client.api("saveRelease", {id: release.id, ...fields});
      else {
        const file = data.get("file") as File;
        if (!file.size || file.size > MAX_UPLOAD_BYTES) {notice(`Choose a file between 1 byte and ${MAX_UPLOAD_LABEL}.`, true); return;}
        uploading = true; uploadPage = "#releases";
        form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach(field => {field.disabled = true;});
        const {id, storagePath} = await client.api<{id: string; storagePath: string}>("beginUpload", {...fields, size: file.size, filename: file.name});
        await uploadFile(client.storage, storagePath, file, form);
        const status = form.querySelector<HTMLElement>("#upload-status")!;
        status.textContent = "Upload complete. Verifying the file… Large files may take a few minutes.";
        await client.api("completeUpload", {id});
      }
      uploading = false; await route(); notice(release ? "Release details saved." : "File uploaded as a draft. Review it, then publish when ready.");
    } catch (error) {
      if (uploading) {uploading = false; await route();}
      notice(`${errorMessage(error)}${!release ? " An unfinished draft can be verified or removed in Manage files." : ""}`, true);
    } finally {
      uploading = false; busy(form, false);
      form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach(field => {field.disabled = false;});
    }
  });
}

async function customersPage(token: number) {
  const first = await client.api<Page<Customer>>("customers"); if (token !== navigating) return;
  let customers = first.items; let cursor = first.next;
  main.innerHTML = heading("Customer access.", "Every purchase source, one email list.") + adminNav("customers")
    + `<div id="customer-import"></div><div class="filters"><label class="sr-only" for="customer-search">Search loaded customers</label><input id="customer-search" type="search" placeholder="Search loaded customers by email or purchase source"></div><div class="table-wrap admin-table" tabindex="0" role="region" aria-label="Customer access list"><table><thead><tr><th>Email</th><th>Source</th><th>Access</th><th>Action</th></tr></thead><tbody id="customers"></tbody></table></div><button class="button secondary load-more" id="more" ${cursor ? "" : "hidden"}>Load more customers</button>`;
  const draw = () => {
    const query = document.querySelector<HTMLInputElement>("#customer-search")!.value.toLowerCase();
    document.querySelector("#customers")!.innerHTML = customers.filter(c => `${c.email} ${c.source}`.toLowerCase().includes(query)).map(c => `<tr><td>${esc(c.email)}${c.role === "admin" ? '<small class="table-sub">Administrator</small>' : ""}</td><td>${esc(c.source || "—")}</td><td><span class="badge ${c.active ? "" : "muted"}">${c.active ? "Active" : "Revoked"}</span></td><td>${c.role === "admin" ? "—" : `<button class="link-button ${c.active ? "danger" : ""}" data-email="${esc(c.email)}" data-active="${!c.active}">${c.active ? "Revoke" : "Restore"}</button>`}</td></tr>`).join("") || '<tr><td colspan="4">No customers found.</td></tr>';
  }; draw();
  document.querySelector("#customer-search")!.addEventListener("input", draw);
  mountCustomerImport(document.querySelector<HTMLElement>("#customer-import")!, {
    send: batch => client.api<{added: number; skipped: number}>("addCustomers", {emails: batch.emails.join("\n"), source: batch.source}),
    busy: value => {
      importing = value;
      document.querySelectorAll<HTMLButtonElement>("#nav button, #customers button, #more").forEach(button => {button.disabled = value;});
      document.querySelectorAll<HTMLAnchorElement>(".header a, .admin-nav a").forEach(link => {
        if (value) link.setAttribute("aria-disabled", "true"); else link.removeAttribute("aria-disabled");
      });
    },
    complete: async () => {
      const refreshed = await client.api<Page<Customer>>("customers"); if (token !== navigating) return;
      customers = refreshed.items; cursor = refreshed.next;
      document.querySelector<HTMLButtonElement>("#more")!.hidden = !cursor; draw();
    },
    error: errorMessage,
  });
  document.querySelector("#customers")!.addEventListener("click", async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-email]"); if (!button) return;
    const active = button.dataset.active === "true";
    if (!active && !confirm(`Revoke access for ${button.dataset.email}? New downloads will be blocked.`)) return;
    button.disabled = true;
    try {await client.api("setAccess", {email: button.dataset.email, active}); await route(); notice(active ? "Access restored. The customer must sign in with a new link." : "Customer access revoked.");}
    catch (error) {notice(errorMessage(error), true); button.disabled = false;}
  });
  document.querySelector("#more")!.addEventListener("click", async event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    try {const result = await client.api<Page<Customer>>("customers", {cursor}); customers = customers.concat(result.items); cursor = result.next; button.hidden = !cursor; draw();}
    catch (error) {notice(errorMessage(error), true);} finally {button.disabled = false;}
  });
}

async function activityPage(token: number) {
  const first = await client.api<Page<Event>>("activity"); if (token !== navigating) return;
  main.innerHTML = heading("Recent activity.", "Customer access, releases, and community contributions.") + adminNav("activity") + '<div class="table-wrap admin-table" tabindex="0" role="region" aria-label="Recent activity"><table><thead><tr><th>Date</th><th>Action</th><th>Details</th><th>Account</th></tr></thead><tbody id="events"></tbody></table></div><button id="more" class="button secondary load-more">Load more activity</button>';
  const append = (items: Event[]) => document.querySelector("#events")!.insertAdjacentHTML("beforeend", items.map(item => `<tr><td>${esc(new Date(item.createdAt).toLocaleString())}</td><td>${esc(item.action)}</td><td>${esc(item.target)}</td><td>${esc(item.actor)}</td></tr>`).join(""));
  append(first.items); if (!first.items.length) document.querySelector("#events")!.innerHTML = '<tr><td colspan="4">No activity yet.</td></tr>';
  let cursor = first.next; const button = document.querySelector<HTMLButtonElement>("#more")!; button.hidden = !cursor;
  button.addEventListener("click", async () => {button.disabled = true; try {const result = await client.api<Page<Event>>("activity", {cursor}); append(result.items); cursor = result.next; button.hidden = !cursor;} catch (error) {notice(errorMessage(error), true);} finally {button.disabled = false;}});
}

async function route() {
  if (!session || completing || uploading || importing) return;
  const token = ++navigating;
  main.innerHTML = '<p class="loading" role="status">Loading…</p>';
  try {
    const page = location.hash.slice(1);
    const community = ["community", "community-mine", "community-manage"].includes(page);
    const adminPage = ["customers", "releases", "activity"].includes(page);
    nav.querySelectorAll<HTMLAnchorElement>("a").forEach(link => {
      const active = link.hash === "#community" ? community : link.hash === "#customers" ? adminPage : !adminPage && !community;
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    if (community) await communityPage(main, page === "community-mine" ? "mine" : page === "community-manage" && session.role === "admin" ? "manage" : "all", {
      api: client.api, storage: client.storage, admin: session.role === "admin", heading, licensePanel: downloadLicensePanel,
      notice, error: errorMessage, download, refresh: route, isCurrent: () => token === navigating,
      setUploading: value => {if (value) uploadPage = location.hash; uploading = value;},
    });
    else if (session.role === "admin" && page === "customers") await customersPage(token);
    else if (session.role === "admin" && page === "releases") await releasesPage(true, token);
    else if (session.role === "admin" && page === "activity") await activityPage(token);
    else await releasesPage(false, token);
    document.title = `${community ? "Community Builds" : session.role === "admin" && adminPage ? "Admin" : "Downloads"} · Camera Hacks`;
  } catch (error) {
    if (token !== navigating) return;
    const code = (error as {code?: string}).code;
    if (code === "functions/permission-denied" || code === "functions/unauthenticated") {await signOut(client.auth); login(errorMessage(error));}
    else {main.innerHTML = '<section class="empty"><h1>Could not load this page.</h1><p>Please try again.</p><button id="retry" class="button">Retry</button></section>'; notice(errorMessage(error), true); document.querySelector("#retry")!.addEventListener("click", () => {void route();});}
  }
}

document.addEventListener("click", event => {
  if (uploading && (event.target as Element).closest(".header a, #nav button, .admin-nav a, .footer a")) {event.preventDefault(); event.stopImmediatePropagation();}
  if (importing && (event.target as Element).closest(".header a, #nav button, .admin-nav a, #customers button, #more")) {event.preventDefault(); event.stopImmediatePropagation();}
}, true);
window.addEventListener("hashchange", () => {
  if (uploading) {history.replaceState(null, "", uploadPage); return;}
  if (importing) {history.replaceState(null, "", "#customers"); return;}
  void route();
});
window.addEventListener("beforeunload", event => {if (uploading || importing) {event.preventDefault(); event.returnValue = "";}});
try {
  client = await connect();
  if (isSignInWithEmailLink(client.auth, location.href)) await finishLink();
  onAuthStateChanged(client.auth, () => {if (!completing) {if (!client.auth.currentUser) {navigating++; session = null; login();} else void loadSession();}});
} catch {
  main.innerHTML = '<section class="panel verify-panel"><h1>We’re getting ready.</h1><p>The download portal is not connected yet. Please check back soon or contact Camera Hacks through the shop.</p></section>';
}
