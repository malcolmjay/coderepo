import type {FirebaseStorage} from "firebase/storage";
import {uploadFile} from "./file-upload";
import {COMMUNITY_CATEGORIES, COMMUNITY_MAX_BYTES, COMMUNITY_MAX_LABEL, COMMUNITY_SHARING} from "../functions/src/community-config.js";

type Build = {id: string; title: string; authorName: string; version: string; kind: string; compatibility: string; notes: string;
  filename: string; size: number; createdAt: number; updatedAt: number; published: boolean; status: string; hasFile: boolean; canManage: boolean;
  pending: null | {id: string; filename: string; status: string}};
type Page = {items: Build[]; next: string | null};
type Context = {
  api: <T>(operation: string, data?: Record<string, unknown>) => Promise<T>; storage: FirebaseStorage; admin: boolean;
  heading: (title: string, description: string, admin: boolean) => string; licensePanel: () => string;
  notice: (message: string, error?: boolean) => void; error: (error: unknown) => string;
  download: (id: string, accepted: () => boolean, operation: string) => Promise<void>;
  setUploading: (busy: boolean) => void; refresh: () => Promise<void>; isCurrent: () => boolean;
};
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));
const bytes = (size: number) => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GiB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(size / 1024)} KiB`;
const categories: Record<string, string> = COMMUNITY_CATEGORIES;
const options = (selected = "") => Object.entries(categories).map(([key, label]) => `<option value="${key}" ${selected === key ? "selected" : ""}>${label}</option>`).join("");

function card(build: Build) {
  return `<article class="release-card community-card"><div class="file-symbol" aria-hidden="true">${build.kind === "models" ? "3D" : "DEV"}</div><div class="release-body"><div class="release-meta"><span>${esc(categories[build.kind])}</span><span class="badge ${build.published ? "" : "muted"}">${build.status === "deleting" ? "Removal pending" : build.published ? "Community build" : "Private draft"}</span></div><h2>${esc(build.title)}</h2><p class="community-author">By ${esc(build.authorName)}</p><p class="compatibility">${esc(build.compatibility)}</p><p class="release-details">v${esc(build.version)} <span>·</span> ${bytes(build.size || 0)} <span>·</span> Updated ${esc(new Intl.DateTimeFormat(undefined, {dateStyle: "medium"}).format(build.updatedAt))}</p><details><summary>About this build & installation</summary><div class="release-notes">${esc(build.notes)}</div><p class="fine">${esc(build.filename)}</p></details>${build.canManage ? `<div class="actions release-actions">${build.status !== "deleting" ? `${!build.pending ? `<button class="link-button" data-edit="${build.id}">Edit build</button>` : `<span class="fine">${build.pending.status === "deleting" ? "Discard pending" : "Upload pending"}: ${esc(build.pending.filename)}</span>${build.pending.status === "uploading" ? `<button class="link-button" data-verify="${build.id}">Verify upload</button>` : ""}<button class="link-button" data-discard="${build.id}">Discard upload</button>`}${build.hasFile && (!build.pending || build.published) ? `<button class="link-button" data-publish="${build.id}">${build.published ? "Unpublish" : "Publish build"}</button>` : ""}` : ""}<button class="link-button danger" data-delete="${build.id}">${build.status === "deleting" ? "Retry deletion" : "Delete build"}</button></div>` : ""}</div>${build.hasFile && build.status === "ready" ? `<button class="button download-button" data-download="${build.id}" aria-label="Download ${esc(build.title)}">Download <span aria-hidden="true">↓</span></button>` : ""}</article>`;
}

export async function communityPage(main: HTMLElement, scope: string, ctx: Context) {
  const first = await ctx.api<Page>("communityBuilds", {scope});
  if (!ctx.isCurrent()) return;
  let items = first.items; let cursor = first.next; let locked = false;
  main.innerHTML = ctx.heading("Community Builds.", "Custom parts. New ideas. Made by the Camera Hacks community.", false)
    + `<section class="panel community-intro"><div class="row"><div><p class="eyebrow">BUILT BY YOU</p><h2>Share what you’ve made.</h2><p>Upload your own STL designs, code changes, or a ZIP with everything needed to try your build. Only you and an admin can edit or delete it.</p></div><button id="new-build" class="button">Upload a build <span aria-hidden="true">↑</span></button></div><div id="community-editor"></div></section>`
    + `<nav class="admin-nav community-nav" aria-label="Community views"><a href="#community" ${scope === "all" ? 'aria-current="page"' : ""}>All builds</a><a href="#community-mine" ${scope === "mine" ? 'aria-current="page"' : ""}>My builds</a>${ctx.admin ? `<a href="#community-manage" ${scope === "manage" ? 'aria-current="page"' : ""}>Manage all builds</a>` : ""}</nav>`
    + ctx.licensePanel()
    + `<div class="filters" role="search"><label class="sr-only" for="community-search">Search loaded community builds</label><input id="community-search" type="search" placeholder="Search loaded builds by title, contributor, or camera…"><label class="sr-only" for="community-category">Build category</label><select id="community-category"><option value="">All categories</option>${options()}</select></div><div class="section-label"><span>${scope === "mine" ? "YOUR BUILDS & DRAFTS" : scope === "manage" ? "ALL BUILDS & DRAFTS" : "SHARED BY THE COMMUNITY"}</span><span id="community-count"></span></div><div id="community-list"></div><button id="community-more" class="button secondary load-more" ${cursor ? "" : "hidden"}>Load more builds</button><aside class="download-note"><strong>Made by customers</strong><p>Community builds are customer contributions, not official Camera Hacks releases. Review the instructions and code, check compatibility, and back up your files before making changes.</p></aside>`;
  const list = main.querySelector<HTMLElement>("#community-list")!;
  const consent = main.querySelector<HTMLInputElement>("#download-license")!;
  const downloading = new Set<string>();
  const accepted = () => consent.isConnected && consent.checked;
  const updateButtons = () => {
    list.querySelectorAll<HTMLButtonElement>("[data-download]").forEach(b => {b.disabled = !accepted() || downloading.has(b.dataset.download!); b.setAttribute("aria-describedby", "license-requirement");});
    main.querySelector("#license-requirement")!.textContent = accepted() ? "License accepted. Downloads are enabled." : "Agree to the license above to enable downloads.";
  };
  const draw = () => {
    const query = main.querySelector<HTMLInputElement>("#community-search")!.value.toLowerCase();
    const kind = main.querySelector<HTMLSelectElement>("#community-category")!.value;
    const filtered = items.filter(item => (!kind || item.kind === kind) && `${item.title} ${item.authorName} ${item.compatibility} ${item.notes}`.toLowerCase().includes(query));
    list.innerHTML = filtered.map(card).join("") || `<section class="empty"><h2>${items.length ? "No matching builds." : scope === "mine" ? "Your next idea starts here." : "Make the first contribution."}</h2><p>${items.length ? "Try another search or category." : "Upload a build, review your draft, then publish it for other customers."}</p></section>`;
    main.querySelector("#community-count")!.textContent = `${filtered.length} ${filtered.length === 1 ? "BUILD" : "BUILDS"}${cursor ? " LOADED" : ""}`;
    updateButtons();
  };
  draw(); consent.addEventListener("change", updateButtons);
  main.querySelector("#community-search")!.addEventListener("input", draw);
  main.querySelector("#community-category")!.addEventListener("change", draw);
  main.querySelector("#community-more")!.addEventListener("click", async event => {
    if (locked) return;
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    try {const result = await ctx.api<Page>("communityBuilds", {scope, cursor}); if (!ctx.isCurrent()) return; items = items.concat(result.items); cursor = result.next; button.hidden = !cursor; draw();}
    catch (error) {if (ctx.isCurrent()) ctx.notice(ctx.error(error), true);} finally {button.disabled = false;}
  });

  function editor(build?: Build) {
    if (locked) return;
    const host = main.querySelector<HTMLElement>("#community-editor")!;
    host.innerHTML = `<form id="community-form" class="stack release-form"><h2>${build ? "Edit your build" : "New community build"}</h2><div class="form-grid"><p><label for="build-title">Build title</label><input id="build-title" name="title" maxlength="120" value="${esc(build?.title)}" placeholder="Compact chimney viewfinder" required></p><p><label for="build-author">Contributor name</label><input id="build-author" name="authorName" maxlength="60" value="${esc(build?.authorName)}" placeholder="Your name or handle" required><span class="helptext">Shown to other customers. Your email stays private.</span></p><p><label for="build-version">Version</label><input id="build-version" name="version" maxlength="40" value="${esc(build?.version || "1.0")}" required></p><p><label for="build-kind">Category</label><select id="build-kind" name="kind">${options(build?.kind || "models")}</select></p></div><p><label for="build-compatibility">Compatible cameras / sensors</label><input id="build-compatibility" name="compatibility" maxlength="200" value="${esc(build?.compatibility)}" placeholder="WLV-01 · IMX294 / IMX492" required></p><p><label for="build-notes">About your build & installation instructions</label><textarea id="build-notes" name="notes" maxlength="10000" rows="6" placeholder="What did you change? How should someone install or print it?" required>${esc(build?.notes)}</textarea></p><p><label for="build-file">${build?.hasFile ? "Replace file (optional)" : "Build file"}</label><input id="build-file" type="file" name="file" ${build?.hasFile ? "" : "required"}><span class="helptext">One file up to ${COMMUNITY_MAX_LABEL}. Use a ZIP for multiple STLs, code files, or instructions. Keep this tab open while uploading.${build?.hasFile ? " A replacement becomes a private draft for review before you publish it again." : ""}</span></p><p class="fine">Share your own designs or code changes. Only include Camera Hacks or third-party files if you have permission to share them.</p><label class="license-checkbox" for="community-sharing"><input id="community-sharing" type="checkbox" ${build?.hasFile ? "" : "required"}><span>${esc(COMMUNITY_SHARING.agreement)}</span></label><progress id="progress" max="100" value="0" hidden aria-label="File upload progress"></progress><p id="upload-status" role="status"></p><div id="upload-controls" class="actions upload-controls" hidden><button class="button secondary" type="button" id="pause-upload">Pause upload</button><button class="button secondary" type="button" id="cancel-upload">Cancel upload</button></div><div class="actions"><button class="button" type="submit">${build ? "Save build" : "Upload as draft"}</button><button class="button secondary" type="button" id="close-build-editor">Cancel</button></div></form>`;
    const form = host.querySelector<HTMLFormElement>("form")!;
    const fileInput = form.querySelector<HTMLInputElement>("#build-file")!;
    const sharing = form.querySelector<HTMLInputElement>("#community-sharing")!;
    fileInput.addEventListener("change", () => {sharing.required = !build?.hasFile || !!fileInput.files?.length;});
    host.querySelector("#close-build-editor")!.addEventListener("click", () => {if (!locked) host.innerHTML = "";});
    host.scrollIntoView({block: "start", behavior: "smooth"}); form.querySelector<HTMLInputElement>("input")!.focus({preventScroll: true});
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (locked) return;
      const data = new FormData(form); const file = fileInput.files?.[0];
      if (file && (!file.size || file.size > COMMUNITY_MAX_BYTES)) {ctx.notice(`Choose a file between 1 byte and ${COMMUNITY_MAX_LABEL}.`, true); return;}
      if ((!build?.hasFile || file) && (!file || !sharing.checked)) {ctx.notice("Choose a file and accept the community sharing agreement.", true); return;}
      const fields = Object.fromEntries([...data.entries()].filter(([key]) => key !== "file"));
      locked = true; ctx.setUploading(true); form.setAttribute("aria-busy", "true");
      form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input,button,select,textarea").forEach(e => {e.disabled = true;});
      let began = false;
      try {
        if (file) {
          const upload = await ctx.api<{id: string; uploadId: string; storagePath: string}>("beginCommunityUpload", {...fields, ...(build ? {id: build.id} : {}), filename: file.name, size: file.size, sharingAccepted: true, sharingVersion: COMMUNITY_SHARING.version});
          began = true;
          await uploadFile(ctx.storage, upload.storagePath, file, form);
          form.querySelector("#upload-status")!.textContent = "Upload complete. Verifying your file…";
          await ctx.api("completeCommunityUpload", {id: upload.id, uploadId: upload.uploadId});
        } else {await ctx.api("saveCommunityBuild", {id: build!.id, ...fields});}
        ctx.setUploading(false); locked = false;
        if (location.hash !== "#community-mine" && scope !== "manage") history.replaceState(null, "", ctx.admin && build ? "#community-manage" : "#community-mine");
        await ctx.refresh(); ctx.notice(file ? "Build saved as a private draft. Review it, then choose Publish build to share it." : "Build details saved.");
      } catch (error) {
        ctx.setUploading(false); locked = false;
        if (began) {if (scope !== "manage") history.replaceState(null, "", ctx.admin && build ? "#community-manage" : "#community-mine"); await ctx.refresh();}
        ctx.notice(`${ctx.error(error)}${began ? " Your pending upload is saved. Verify it if the transfer finished, or discard it to try again." : ""}`, true);
      } finally {
        ctx.setUploading(false); locked = false; form.setAttribute("aria-busy", "false");
        form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input,button,select,textarea").forEach(e => {e.disabled = false;});
      }
    });
  }
  main.querySelector("#new-build")!.addEventListener("click", () => editor());
  list.addEventListener("click", async event => {
    if (locked) return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!button) return;
    const id = button.dataset.download || button.dataset.edit || button.dataset.verify || button.dataset.discard || button.dataset.publish || button.dataset.delete;
    const build = items.find(item => item.id === id); if (!build) return;
    if (button.dataset.download) {
      if (!accepted() || downloading.has(build.id)) return;
      downloading.add(build.id); updateButtons();
      try {await ctx.download(build.id, accepted, "downloadCommunityBuild");} finally {downloading.delete(build.id); updateButtons();} return;
    }
    if (!build.canManage) return;
    if (button.dataset.edit) {editor(build); return;}
    if (button.dataset.delete && !confirm(`Permanently delete “${build.title}” and its files? This cannot be undone.`)) return;
    if (button.dataset.discard && !confirm("Discard this pending upload? Any previously verified file will be kept.")) return;
    locked = true; button.disabled = true;
    try {
      if (button.dataset.verify) await ctx.api("completeCommunityUpload", {id: build.id, uploadId: build.pending!.id});
      if (button.dataset.discard) await ctx.api("cancelCommunityUpload", {id: build.id, uploadId: build.pending!.id});
      if (button.dataset.publish) await ctx.api("publishCommunityBuild", {id: build.id, published: !build.published});
      if (button.dataset.delete) await ctx.api("deleteCommunityBuild", {id: build.id});
      if (!ctx.isCurrent()) return;
      await ctx.refresh();
      ctx.notice(button.dataset.delete ? "Community build deleted." : button.dataset.discard ? "Pending upload discarded." : button.dataset.verify ? "Build verified. Review your draft, then publish it." : build.published ? "Build unpublished. It is now private." : "Build published to Community Builds.");
    } catch (error) {if (ctx.isCurrent()) ctx.notice(ctx.error(error), true);} finally {locked = false; button.disabled = false;}
  });
}
