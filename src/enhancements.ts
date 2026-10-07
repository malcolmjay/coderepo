import {ENHANCEMENT_STATUSES, type EnhancementStatus} from "../functions/src/enhancement-config.js";

type Enhancement = {id: string; title: string; description: string; status: EnhancementStatus; statusNote: string;
  createdAt: number; statusUpdatedAt: number | null; reviewVersion: number; likeCount: number; liked: boolean; mine: boolean};
type Review = Pick<Enhancement, "status" | "statusNote" | "statusUpdatedAt" | "reviewVersion">;
type Page = {items: Enhancement[]; next: string | null};
type Context = {
  api: <T>(operation: string, data?: Record<string, unknown>) => Promise<T>; admin: boolean;
  heading: (title: string, description: string, admin: boolean) => string;
  notice: (message: string, error?: boolean) => void; error: (error: unknown) => string; isCurrent: () => boolean;
};
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));
const date = (value: number) => new Intl.DateTimeFormat(undefined, {dateStyle: "medium"}).format(value);
const statusOptions = (selected = "") => ENHANCEMENT_STATUSES.map(status => `<option value="${status}" ${status === selected ? "selected" : ""}>${status}</option>`).join("");
const statusStyle = (status: EnhancementStatus) => ({"Pending Review": "pending", Approved: "approved", "Not Approved": "declined", "Pending Development": "queued", "In Development": "developing", Testing: "testing", Live: "live"}[status]);
const heart = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>';

function card(item: Enhancement, admin: boolean, pending: boolean) {
  return `<article class="request-card" aria-labelledby="request-title-${item.id}"><button class="request-like ${item.liked ? "is-liked" : ""}" data-like="${item.id}" aria-pressed="${item.liked}" aria-label="${item.liked ? "Unlike" : "Like"} ${esc(item.title)}" ${pending ? "disabled" : ""}>${heart}<strong>${item.likeCount}</strong><span>${item.liked ? "Liked" : "Like"}</span></button><div class="request-body"><div class="release-meta"><span class="badge request-status status-${statusStyle(item.status)}">${esc(item.status)}</span>${item.mine ? '<span>Your request</span>' : ""}<span>Submitted ${date(item.createdAt)}</span></div><h2 id="request-title-${item.id}">${esc(item.title)}</h2><p class="request-description">${esc(item.description)}</p><div class="request-note"><h3>Status note</h3><p>${esc(item.statusNote || "No status note yet.")}</p>${item.statusUpdatedAt ? `<small>Updated ${date(item.statusUpdatedAt)}</small>` : ""}</div>${admin ? `<div class="actions release-actions"><button class="link-button" data-review="${item.id}">Update status & note</button></div>` : ""}</div></article>`;
}

export async function enhancementsPage(main: HTMLElement, ctx: Context) {
  const first = await ctx.api<Page>("enhancementRequests", {sort: "newest"});
  if (!ctx.isCurrent()) return;
  let items = first.items; let cursor = first.next; let saving = false; let loading = false; let listVersion = 0;
  const pendingLikes = new Set<string>();
  main.innerHTML = ctx.heading("Enhancement Requests.", "Share an idea, support requests you’d like to see, and follow their progress.", false)
    + `<section class="panel request-intro"><div class="row"><div><p class="eyebrow">HELP SHAPE WHAT’S NEXT</p><h2>What would make your camera better?</h2><p>Describe your idea and why it would help. New requests start at Pending Review. Like a request to show your support.</p></div><button class="button" id="new-request">Submit a request <span aria-hidden="true">+</span></button></div><div id="enhancement-editor"></div></section>`
    + `<div class="request-filters" role="search"><p><label for="request-search">Search loaded requests</label><input id="request-search" type="search" placeholder="Search titles and descriptions…"></p><p><label for="request-status">Status of loaded requests</label><select id="request-status"><option value="">All statuses</option>${statusOptions()}</select></p><p><label for="request-sort">Sort requests</label><select id="request-sort"><option value="newest">Newest first</option><option value="popular">Most liked</option></select></p></div><div class="section-label"><span>IDEAS FROM THE COMMUNITY</span><span id="request-count"></span></div><p id="request-feedback" class="sr-only" role="status"></p><div id="request-list"></div><button id="more-requests" class="button secondary load-more" ${cursor ? "" : "hidden"}>Load more requests</button>`;
  const list = main.querySelector<HTMLElement>("#request-list")!;
  const host = main.querySelector<HTMLElement>("#enhancement-editor")!;
  const more = main.querySelector<HTMLButtonElement>("#more-requests")!;
  const search = main.querySelector<HTMLInputElement>("#request-search")!;
  const filter = main.querySelector<HTMLSelectElement>("#request-status")!;
  const sort = main.querySelector<HTMLSelectElement>("#request-sort")!;
  const feedback = main.querySelector<HTMLElement>("#request-feedback")!;
  function draw(focusLike?: string) {
    const query = search.value.trim().toLowerCase();
    const visible = items.filter(item => (!filter.value || item.status === filter.value) && `${item.title} ${item.description}`.toLowerCase().includes(query));
    visible.sort((a, b) => sort.value === "popular" ? b.likeCount - a.likeCount || b.createdAt - a.createdAt : b.createdAt - a.createdAt);
    list.innerHTML = visible.map(item => card(item, ctx.admin, loading || pendingLikes.has(item.id))).join("") || `<section class="empty"><h2>${items.length ? "No matching requests." : "What should we build next?"}</h2><p>${items.length ? "Try another search or status, or load more requests." : "Be the first to suggest an enhancement for the community."}</p></section>`;
    main.querySelector("#request-count")!.textContent = `${visible.length} OF ${items.length} LOADED`;
    more.hidden = !cursor;
    if (focusLike) list.querySelector<HTMLButtonElement>(`[data-like="${focusLike}"]`)?.focus({preventScroll: true});
  }
  draw(); search.addEventListener("input", () => draw()); filter.addEventListener("change", () => draw());
  async function load(reset: boolean) {
    if (loading && !reset) return;
    const version = ++listVersion;
    loading = true; more.disabled = true;
    list.querySelectorAll<HTMLButtonElement>("[data-like]").forEach(button => {button.disabled = true;});
    try {
      const result = await ctx.api<Page>("enhancementRequests", {sort: sort.value, ...(reset ? {} : {cursor})});
      if (!ctx.isCurrent() || version !== listVersion) return;
      items = reset ? result.items : [...new Map([...items, ...result.items].map(item => [item.id, item])).values()];
      cursor = result.next; draw(); return true;
    } catch (error) {if (ctx.isCurrent() && version === listVersion) ctx.notice(ctx.error(error), true);}
    finally {if (version === listVersion) {loading = false; more.disabled = pendingLikes.size > 0; list.querySelectorAll<HTMLButtonElement>("[data-like]").forEach(button => {button.disabled = pendingLikes.has(button.dataset.like!);});}}
  }
  sort.addEventListener("change", () => {void load(true);}); more.addEventListener("click", () => {void load(false);});

  function setSaving(form: HTMLFormElement, value: boolean) {
    saving = value; form.setAttribute("aria-busy", String(value));
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input,textarea,select,button").forEach(element => {element.disabled = value;});
    const newButton = main.querySelector<HTMLButtonElement>("#new-request");
    if (ctx.isCurrent() && newButton) newButton.disabled = value;
  }
  function closeEditor() {if (!saving) {host.innerHTML = ""; main.querySelector<HTMLButtonElement>("#new-request")!.focus({preventScroll: true});}}
  function openEditor(item?: Enhancement) {
    if (saving) return;
    const id = item?.id ?? crypto.randomUUID().replaceAll("-", "");
    host.innerHTML = item ? `<form id="enhancement-form" class="stack release-form"><p class="eyebrow">ADMINISTRATOR REVIEW</p><h2>${esc(item.title)}</h2><p><label for="review-status">Status</label><select id="review-status" name="status">${statusOptions(item.status)}</select></p><p><label for="review-note">Status note</label><textarea id="review-note" name="statusNote" rows="4" maxlength="5000" placeholder="Add context about the current status…">${esc(item.statusNote)}</textarea><span class="helptext">Visible to all authorized customers. Saving replaces the current note.</span></p><div class="actions"><button class="button" type="submit">Save status & note</button><button id="cancel-request" class="button secondary" type="button">Cancel</button></div></form>`
      : `<form id="enhancement-form" class="stack release-form"><h2>New enhancement request</h2><p><label for="enhancement-title">Request title</label><input id="enhancement-title" name="title" maxlength="120" placeholder="A short, specific description of your idea" required></p><p><label for="enhancement-description">Describe your enhancement</label><textarea id="enhancement-description" name="description" rows="5" maxlength="5000" placeholder="What would you like to change, and how would it help? Include the camera or software version if relevant." required></textarea><span class="helptext">Your request is visible to other authorized customers. Your email address stays private.</span></p><div class="actions"><button class="button" type="submit">Submit request</button><button id="cancel-request" class="button secondary" type="button">Cancel</button></div></form>`;
    const form = host.querySelector<HTMLFormElement>("form")!;
    form.querySelector("#cancel-request")!.addEventListener("click", closeEditor);
    host.scrollIntoView({block: "start", behavior: "smooth"}); form.querySelector<HTMLInputElement | HTMLSelectElement>("input,select")!.focus({preventScroll: true});
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (saving) return;
      const fields = Object.fromEntries(new FormData(form)); setSaving(form, true);
      try {
        if (item) {
          const review = await ctx.api<Review>("reviewEnhancement", {id, ...fields, reviewVersion: item.reviewVersion});
          if (!ctx.isCurrent()) return;
          items = items.map(current => current.id === id ? {...current, ...review} : current);
          draw(); ctx.notice("Status and note saved.");
        } else {
          await ctx.api("submitEnhancement", {id, ...fields});
          if (!ctx.isCurrent()) return;
          search.value = ""; filter.value = ""; sort.value = "newest";
          const refreshed = await load(true); if (!ctx.isCurrent()) return;
          ctx.notice(refreshed ? "Request submitted. Its status is Pending Review." : "Request submitted. Refresh the page to see it in the list.", !refreshed);
        }
        setSaving(form, false); host.innerHTML = "";
        main.querySelector<HTMLButtonElement>("#new-request")!.focus({preventScroll: true});
      } catch (error) {if (ctx.isCurrent()) ctx.notice(ctx.error(error), true);}
      finally {setSaving(form, false);}
    });
  }
  main.querySelector("#new-request")!.addEventListener("click", () => openEditor());
  list.addEventListener("click", async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!button) return;
    const id = button.dataset.like || button.dataset.review;
    const item = items.find(item => item.id === id); if (!item) return;
    if (button.dataset.review) {if (ctx.admin) openEditor(item); return;}
    if (!button.dataset.like || loading || pendingLikes.has(item.id)) return;
    pendingLikes.add(item.id); button.disabled = true; sort.disabled = true; more.disabled = true;
    try {
      const result = await ctx.api<{liked: boolean; likeCount: number}>("setEnhancementLike", {id: item.id, liked: !item.liked});
      if (!ctx.isCurrent()) return;
      items = items.map(current => current.id === item.id ? {...current, ...result} : current);
      feedback.textContent = `${result.liked ? "Liked" : "Unliked"} ${item.title}. ${result.likeCount} ${result.likeCount === 1 ? "like" : "likes"}.`;
    } catch (error) {if (ctx.isCurrent()) ctx.notice(ctx.error(error), true);}
    finally {pendingLikes.delete(item.id); if (ctx.isCurrent()) {sort.disabled = pendingLikes.size > 0; more.disabled = loading || pendingLikes.size > 0; draw(item.id);}}
  });
}
