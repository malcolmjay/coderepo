import { randomUUID } from "node:crypto";
import { getFirestore, type Transaction, type DocumentReference, type Query, type DocumentData } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { assertAccess, assertDownloadLicense, bulkEmails, email, filename, PortalError, releaseFields, releaseId, text, uploadSize, type Identity, type Member } from "./domain.js";
import { DOWNLOAD_LICENSE } from "./download-license.js";
import {COMMUNITY_OPERATIONS, communityDispatch} from "./community-service.js";

const db = () => getFirestore();
const memberRef = (value: string) => db().collection("members").doc(value);
const auditRef = () => db().collection("activity").doc();
const now = () => Date.now();
const activity = (actor: string, action: string, target: string) => ({actor, action, target, createdAt: now()});

async function access(identity: Identity | undefined, admin = false) {
  if (!identity || identity.email_verified !== true) throw new PortalError("unauthenticated", "Please sign in with your email link.");
  const ref = memberRef(email(identity.email));
  const member = (await ref.get()).data() as Member | undefined;
  return {ref, member: assertAccess(identity, member, admin)};
}

async function authorizeTransaction(tx: Transaction, ref: DocumentReference, identity: Identity) {
  assertAccess(identity, (await tx.get(ref)).data() as Member | undefined, true);
}

function publicRelease(doc: DocumentData, id: string) {
  // Explicit allowlist: storage paths, upload ownership, and generation stay private.
  return {id, title: doc.title, version: doc.version, kind: doc.kind, compatibility: doc.compatibility,
    notes: doc.notes, sha256: doc.sha256, filename: doc.filename, size: doc.size,
    published: doc.published, status: doc.status, publishedAt: doc.publishedAt, createdAt: doc.createdAt};
}

async function page(query: Query, collection: string, cursor: unknown, size = 50) {
  if (cursor) {
    const id = collection === "members" ? email(cursor) : text(cursor, "cursor", 128);
    const snapshot = await db().collection(collection).doc(id).get();
    if (!snapshot.exists) throw new PortalError("invalid-argument", "The list changed. Refresh and try again.");
    query = query.startAfter(snapshot);
  }
  const result = await query.limit(size + 1).get();
  return {docs: result.docs.slice(0, size), next: result.size > size ? result.docs[size - 1].id : null};
}

export async function dispatch(identity: Identity | undefined, input: unknown): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PortalError("invalid-argument", "Invalid request.");
  const data = input as Record<string, unknown>;
  const operation = text(data.operation, "operation", 40);
  const customerOperations = new Set(["access", "releases", "download", ...COMMUNITY_OPERATIONS]);
  const {ref, member} = await access(identity, !customerOperations.has(operation) || data.admin === true);
  const user = identity!;

  if (COMMUNITY_OPERATIONS.has(operation)) return communityDispatch(operation, data, user, member, ref);

  if (operation === "access") return {email: member.email, role: member.role};

  if (operation === "releases") {
    const admin = data.admin === true;
    const query = admin ? db().collection("releases").orderBy("createdAt", "desc")
      : db().collection("releases").where("published", "==", true).orderBy("publishedAt", "desc");
    const result = await page(query, "releases", data.cursor);
    return {items: result.docs.map(doc => publicRelease(doc.data(), doc.id)), next: result.next};
  }

  if (operation === "customers") {
    const result = await page(db().collection("members").orderBy("email"), "members", data.cursor, 100);
    return {items: result.docs.map(doc => doc.data()), next: result.next};
  }

  if (operation === "activity") {
    const result = await page(db().collection("activity").orderBy("createdAt", "desc"), "activity", data.cursor);
    return {items: result.docs.map(doc => ({id: doc.id, ...doc.data()})), next: result.next};
  }

  if (operation === "addCustomers") {
    const addresses = bulkEmails(data.emails);
    const source = text(data.source ?? "", "purchase source", 120, false);
    return db().runTransaction(async tx => {
      await authorizeTransaction(tx, ref, user);
      const snapshots = await tx.getAll(...addresses.map(memberRef));
      let added = 0;
      for (const snapshot of snapshots) {
        if (snapshot.exists) continue; // Bulk import must never silently restore a revoked customer.
        const stamp = now();
        tx.create(snapshot.ref, {email: snapshot.id, source, role: "customer", active: true, validAfter: 0, createdAt: stamp, updatedAt: stamp});
        added++;
      }
      tx.create(auditRef(), activity(member.email, "Customers added", `${added} added; ${addresses.length - added} unchanged`));
      return {added, skipped: addresses.length - added};
    });
  }

  if (operation === "setAccess") {
    const target = memberRef(email(data.email));
    if (typeof data.active !== "boolean") throw new PortalError("invalid-argument", "Choose an access status.");
    return db().runTransaction(async tx => {
      await authorizeTransaction(tx, ref, user);
      const snapshot = await tx.get(target);
      if (!snapshot.exists) throw new PortalError("not-found", "Customer not found.");
      if (snapshot.get("role") === "admin") throw new PortalError("permission-denied", "Manage administrators with the trusted admin setup command.");
      if (snapshot.get("active") === data.active) return {ok: true};
      // auth_time is in whole seconds. The following second prevents a previous
      // session from becoming valid again when access is restored quickly.
      tx.update(target, {active: data.active, validAfter: Math.floor(now() / 1000) * 1000 + 1000, updatedAt: now()});
      tx.create(auditRef(), activity(member.email, data.active ? "Access restored" : "Access revoked", target.id));
      return {ok: true};
    });
  }

  if (operation === "beginUpload") {
    const fields = releaseFields(data);
    const size = uploadSize(data.size);
    const safeName = filename(data.filename);
    const id = randomUUID().replaceAll("-", "");
    const storagePath = `releases/${id}/payload`;
    const uploadPath = `uploads/${id}/payload`;
    await db().runTransaction(async tx => {
      await authorizeTransaction(tx, ref, user);
      tx.create(db().collection("releases").doc(id), {...fields, filename: safeName, size, storagePath, uploadPath,
        status: "uploading", published: false, generation: null, uploadedBy: user.uid,
        createdAt: now(), updatedAt: now(), publishedAt: null});
      tx.create(auditRef(), activity(member.email, "Upload started", fields.title));
    });
    return {id, storagePath: uploadPath};
  }

  if (operation === "completeUpload") {
    const release = db().collection("releases").doc(releaseId(data.id));
    const snapshot = await release.get();
    if (!snapshot.exists) throw new PortalError("not-found", "Release not found.");
    const record = snapshot.data()!;
    if (record.status === "ready") return {ok: true};
    if (record.status !== "uploading") throw new PortalError("failed-precondition", "The release is being removed. Refresh the page.");
    const bucket = getStorage().bucket();
    const file = bucket.file(record.storagePath);
    const upload = bucket.file(record.uploadPath);
    const [exists] = await file.exists();
    if (!exists) {
      let metadata;
      try { [metadata] = await upload.getMetadata(); } catch { throw new PortalError("failed-precondition", "The upload is not complete. Try uploading again."); }
      if (Number(metadata.size) !== record.size || metadata.contentType !== "application/octet-stream" || !metadata.generation) {
        throw new PortalError("failed-precondition", "The uploaded file did not match its release. Remove this draft and upload again.");
      }
      // Firebase uploads may acquire permanent download tokens. Promote a
      // generation-pinned source into a create-only private object with fresh
      // metadata, then delete staging before publication is possible. The server
      // copy stays within the bucket; no firmware bytes pass through the Function.
      try {
        await bucket.file(record.uploadPath, {generation: String(metadata.generation)}).copy(file, {
          preconditionOpts: {ifGenerationMatch: 0}, contentType: "application/octet-stream",
          cacheControl: "private, no-store", contentDisposition: `attachment; filename="${record.filename}"`,
          metadata: {portalReleaseId: release.id, firebaseStorageDownloadTokens: null},
        });
      } catch (error) {
        // Another completion request can win the create-only copy race.
        if ((error as {code?: number}).code !== 412) throw error;
      }
    }
    const [verified] = await file.getMetadata();
    if (Number(verified.size) !== record.size || verified.contentType !== "application/octet-stream" || !verified.generation
        || verified.metadata?.portalReleaseId !== release.id || verified.metadata?.firebaseStorageDownloadTokens
        || verified.cacheControl !== "private, no-store") {
      throw new PortalError("failed-precondition", "File verification failed. Please retry.");
    }
    await upload.delete({ignoreNotFound: true});
    await db().runTransaction(async tx => {
      await authorizeTransaction(tx, ref, user);
      const current = await tx.get(release);
      if (current.get("status") === "ready") return;
      if (current.get("status") !== "uploading") throw new PortalError("failed-precondition", "The release changed. Refresh the page.");
      tx.update(release, {status: "ready", generation: String(verified.generation), updatedAt: now()});
      tx.create(auditRef(), activity(member.email, "Upload verified", record.title));
    });
    return {ok: true};
  }

  if (operation === "saveRelease" || operation === "publish") {
    const release = db().collection("releases").doc(releaseId(data.id));
    const fields = operation === "saveRelease" ? releaseFields(data) : null;
    if (operation === "publish" && typeof data.published !== "boolean") throw new PortalError("invalid-argument", "Choose a publication status.");
    await db().runTransaction(async tx => {
      await authorizeTransaction(tx, ref, user);
      const snapshot = await tx.get(release);
      if (!snapshot.exists) throw new PortalError("not-found", "Release not found.");
      if (operation === "publish" && data.published && (snapshot.get("status") !== "ready" || !snapshot.get("generation"))) throw new PortalError("failed-precondition", "Complete and verify the upload before publishing.");
      tx.update(release, fields ? {...fields, updatedAt: now()} : {published: data.published, publishedAt: data.published ? now() : null, updatedAt: now()});
      tx.create(auditRef(), activity(member.email, fields ? "Release edited" : data.published ? "Release published" : "Release unpublished", snapshot.get("title")));
    });
    return {ok: true};
  }

  if (operation === "deleteDraft") {
    const release = db().collection("releases").doc(releaseId(data.id));
    // Reserve the draft before touching storage; a concurrent publish cannot win.
    const paths = await db().runTransaction(async tx => {
      await authorizeTransaction(tx, ref, user);
      const snapshot = await tx.get(release);
      if (!snapshot.exists) throw new PortalError("not-found", "Release not found.");
      if (snapshot.get("published")) throw new PortalError("failed-precondition", "Unpublish this release before removing it.");
      tx.update(release, {status: "deleting", updatedAt: now()});
      return [snapshot.get("storagePath"), snapshot.get("uploadPath")] as string[];
    });
    await Promise.all(paths.map(path => getStorage().bucket().file(path).delete({ignoreNotFound: true})));
    await db().runTransaction(async tx => {
      await authorizeTransaction(tx, ref, user);
      const snapshot = await tx.get(release);
      if (snapshot.get("status") !== "deleting") throw new PortalError("failed-precondition", "The draft changed. Refresh and try again.");
      tx.delete(release);
      tx.create(auditRef(), activity(member.email, "Draft removed", snapshot.get("title")));
    });
    return {ok: true};
  }

  if (operation === "download") {
    const id = releaseId(data.id);
    const release = await db().collection("releases").doc(id).get();
    const record = release.data();
    if (!record || record.status !== "ready" || !record.generation || (!record.published && member.role !== "admin")) throw new PortalError("not-found", "This file is not available.");
    assertDownloadLicense(data.licenseAccepted, data.licenseVersion);
    // Record explicit consent before issuing a link, including the server's
    // wording and timestamp. This records acceptance, not a completed transfer.
    await auditRef().create({...activity(member.email, "Download license accepted", record.title),
      uid: user.uid, releaseId: id, licenseVersion: DOWNLOAD_LICENSE.version,
      licenseTitle: DOWNLOAD_LICENSE.title, licenseText: DOWNLOAD_LICENSE.paragraphs.join("\n\n"),
      agreement: DOWNLOAD_LICENSE.agreement});
    // No emulator-only download backdoor: signed URLs require real IAM signing.
    const [url] = await getStorage().bucket().file(record.storagePath).getSignedUrl({
      version: "v4", action: "read", expires: now() + 60_000,
      responseDisposition: `attachment; filename="${record.filename}"`,
      responseType: "application/octet-stream", queryParams: {generation: record.generation},
    });
    return {url, expiresIn: 60};
  }
  throw new PortalError("invalid-argument", "Unknown operation.");
}
