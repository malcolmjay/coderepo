import {randomUUID} from "node:crypto";
import {getFirestore, type DocumentData, type DocumentReference, type Transaction} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
import {assertAccess, assertDownloadLicense, filename, PortalError, releaseId, type Identity, type Member} from "./domain.js";
import {assertBuildOwner, assertSharing, communityFields, communitySize} from "./community-domain.js";
import {COMMUNITY_SHARING} from "./community-config.js";
import {DOWNLOAD_LICENSE} from "./download-license.js";

export const COMMUNITY_OPERATIONS = new Set(["communityBuilds", "beginCommunityUpload", "completeCommunityUpload", "cancelCommunityUpload", "saveCommunityBuild", "publishCommunityBuild", "deleteCommunityBuild", "downloadCommunityBuild"]);
const db = () => getFirestore();
const builds = () => db().collection("communityBuilds");
const audit = (actor: string, action: string, record: DocumentData, id: string) => ({actor, action, target: record.title, buildId: id, createdAt: Date.now()});
const canManage = (record: DocumentData, user: Identity, member: Member) => record.uploadedBy === user.uid || member.role === "admin";

async function authorize(tx: Transaction, ref: DocumentReference, user: Identity, build: DocumentReference) {
  const member = assertAccess(user, (await tx.get(ref)).data() as Member | undefined);
  const snapshot = await tx.get(build);
  if (!snapshot.exists) throw new PortalError("not-found", "Community build not found.");
  const record = snapshot.data()!;
  assertBuildOwner(user.uid, member.role, record.uploadedBy);
  return record;
}

function available(record: DocumentData) {
  if (record.status === "deleting") throw new PortalError("failed-precondition", "This build is being removed. Retry deleting it.");
}

function publicBuild(record: DocumentData, id: string, user: Identity, member: Member) {
  const manage = canManage(record, user, member);
  // Never expose account emails, UIDs, Storage paths, or generations.
  return {id, title: record.title, authorName: record.authorName, version: record.version, kind: record.kind,
    compatibility: record.compatibility, notes: record.notes, createdAt: record.createdAt, updatedAt: record.updatedAt,
    publishedAt: record.publishedAt, published: record.published, status: record.status,
    filename: record.file?.filename ?? record.pending?.filename, size: record.file?.size ?? record.pending?.size,
    hasFile: !!record.file, canManage: manage,
    pending: manage && record.pending ? {id: record.pending.id, filename: record.pending.filename, status: record.pending.status} : null};
}

async function removeObjects(paths: string[]) {
  await Promise.all([...new Set(paths)].map(path => getStorage().bucket().file(path).delete({ignoreNotFound: true})));
}

// Retired objects remain private if a Storage delete fails. Preserve their paths
// in Firestore so a retry or the next edit can finish the cleanup.
async function cleanup(build: DocumentReference) {
  const record = (await build.get()).data();
  const paths: string[] = record?.retiredPaths ?? [];
  if (!paths.length) return;
  await removeObjects(paths);
  await db().runTransaction(async tx => {
    const current = await tx.get(build);
    if (current.exists) tx.update(build, {retiredPaths: (current.get("retiredPaths") as string[] ?? []).filter(path => !paths.includes(path))});
  });
}

export async function communityDispatch(operation: string, data: Record<string, unknown>, user: Identity, member: Member, memberRef: DocumentReference): Promise<unknown> {
  if (operation === "communityBuilds") {
    const scope = data.scope ?? "all";
    if (!["all", "mine", "manage"].includes(scope as string)) throw new PortalError("invalid-argument", "Choose a community view.");
    if (scope === "manage" && member.role !== "admin") throw new PortalError("permission-denied", "Only administrators can view all drafts.");
    let query = scope === "all" ? builds().where("published", "==", true).orderBy("publishedAt", "desc")
      : scope === "mine" ? builds().where("uploadedBy", "==", user.uid).orderBy("createdAt", "desc") : builds().orderBy("createdAt", "desc");
    if (data.cursor) {
      const cursor = await builds().doc(releaseId(data.cursor)).get();
      if (!cursor.exists || (scope === "all" && !cursor.get("published")) || (scope === "mine" && cursor.get("uploadedBy") !== user.uid)) {
        throw new PortalError("invalid-argument", "The build list changed. Refresh and try again.");
      }
      query = query.startAfter(cursor);
    }
    const result = await query.limit(51).get();
    return {items: result.docs.slice(0, 50).map(doc => publicBuild(doc.data(), doc.id, user, member)), next: result.size > 50 ? result.docs[49].id : null};
  }

  if (operation === "beginCommunityUpload") {
    assertSharing(data);
    const fields = communityFields(data);
    const size = communitySize(data.size);
    const safeName = filename(data.filename);
    const id = data.id === undefined ? randomUUID().replaceAll("-", "") : releaseId(data.id);
    const build = builds().doc(id);
    const uploadId = randomUUID().replaceAll("-", "");
    const pending = {id: uploadId, status: "uploading", fields, filename: safeName, size, uploadedBy: user.uid,
      uploadPath: `community-uploads/${id}/${uploadId}/payload`, storagePath: `community-files/${id}/${uploadId}/payload`};
    if (data.id !== undefined) {
      // Authorize before any maintenance work on an existing build.
      const record = (await build.get()).data();
      if (!record) throw new PortalError("not-found", "Community build not found.");
      assertBuildOwner(user.uid, member.role, record.uploadedBy);
      await cleanup(build);
    }
    await db().runTransaction(async tx => {
      const currentMember = assertAccess(user, (await tx.get(memberRef)).data() as Member | undefined);
      if (data.id !== undefined) {
        const snapshot = await tx.get(build);
        if (!snapshot.exists) throw new PortalError("not-found", "Community build not found.");
        const record = snapshot.data()!;
        assertBuildOwner(user.uid, currentMember.role, record.uploadedBy); available(record);
        if (record.pending) throw new PortalError("failed-precondition", "Finish or discard the pending upload before replacing the file.");
        tx.update(build, {pending, updatedAt: Date.now()});
      } else {
        tx.create(build, {...fields, uploadedBy: user.uid, file: null, pending, status: "uploading", published: false,
          createdAt: Date.now(), updatedAt: Date.now(), publishedAt: null, retiredPaths: []});
      }
      tx.create(db().collection("activity").doc(), {...audit(member.email, "Community upload started", fields, id),
        uid: user.uid, uploadId, sharingVersion: COMMUNITY_SHARING.version, agreement: COMMUNITY_SHARING.agreement});
    });
    return {id, uploadId, storagePath: pending.uploadPath};
  }

  const build = builds().doc(releaseId(data.id));
  if (operation === "downloadCommunityBuild") {
    const record = (await build.get()).data();
    if (!record || record.status !== "ready" || !record.file?.generation || (!record.published && !canManage(record, user, member))) {
      throw new PortalError("not-found", "This community file is not available.");
    }
    assertDownloadLicense(data.licenseAccepted, data.licenseVersion);
    await db().collection("activity").add({...audit(member.email, "Community download license accepted", record, build.id),
      uid: user.uid, licenseVersion: DOWNLOAD_LICENSE.version, licenseTitle: DOWNLOAD_LICENSE.title,
      licenseText: DOWNLOAD_LICENSE.paragraphs.join("\n\n"), agreement: DOWNLOAD_LICENSE.agreement});
    const [url] = await getStorage().bucket().file(record.file.storagePath).getSignedUrl({version: "v4", action: "read", expires: Date.now() + 60_000,
      responseDisposition: `attachment; filename="${record.file.filename}"`, responseType: "application/octet-stream", queryParams: {generation: record.file.generation}});
    return {url, expiresIn: 60};
  }

  if (operation === "saveCommunityBuild" || operation === "publishCommunityBuild") {
    const fields = operation === "saveCommunityBuild" ? communityFields(data) : null;
    if (!fields && typeof data.published !== "boolean") throw new PortalError("invalid-argument", "Choose a publication status.");
    await db().runTransaction(async tx => {
      const record = await authorize(tx, memberRef, user, build); available(record);
      if (fields && record.pending) throw new PortalError("failed-precondition", "Finish or discard the pending upload before editing details.");
      if (!fields && data.published && (!record.file?.generation || record.status !== "ready" || record.pending)) {
        throw new PortalError("failed-precondition", "Complete and verify the upload before sharing this build.");
      }
      tx.update(build, fields ? {...fields, updatedAt: Date.now()} : {published: data.published, publishedAt: data.published ? Date.now() : null, updatedAt: Date.now()});
      tx.create(db().collection("activity").doc(), audit(member.email, fields ? "Community build edited" : data.published ? "Community build published" : "Community build unpublished", record, build.id));
    });
    return {ok: true};
  }

  if (operation === "completeCommunityUpload") {
    const uploadId = releaseId(data.uploadId);
    const record = await db().runTransaction(async tx => {
      const value = await authorize(tx, memberRef, user, build); available(value); return value;
    });
    if (record.file?.id === uploadId) {await cleanup(build); return {ok: true};}
    const pending = record.pending;
    if (!pending || pending.id !== uploadId || pending.status !== "uploading") throw new PortalError("failed-precondition", "This upload changed. Refresh the page.");
    const bucket = getStorage().bucket();
    const file = bucket.file(pending.storagePath);
    const staging = bucket.file(pending.uploadPath);
    try {
      if (!(await file.exists())[0]) {
        let metadata;
        try {[metadata] = await staging.getMetadata();} catch {throw new PortalError("failed-precondition", "The upload is not complete. Discard it and try again.");}
        if (Number(metadata.size) !== pending.size || metadata.contentType !== "application/octet-stream" || !metadata.generation) throw new PortalError("failed-precondition", "The file did not match the declared upload.");
        try {
          await bucket.file(pending.uploadPath, {generation: String(metadata.generation)}).copy(file, {
            preconditionOpts: {ifGenerationMatch: 0}, contentType: "application/octet-stream", cacheControl: "private, no-store",
            contentDisposition: `attachment; filename="${pending.filename}"`, metadata: {communityBuildId: build.id, communityUploadId: uploadId, firebaseStorageDownloadTokens: null},
          });
        } catch (error) {if ((error as {code?: number}).code !== 412) throw error;}
      }
      const [verified] = await file.getMetadata();
      if (Number(verified.size) !== pending.size || verified.contentType !== "application/octet-stream" || !verified.generation
        || verified.metadata?.communityBuildId !== build.id || verified.metadata?.communityUploadId !== uploadId
        || verified.metadata?.firebaseStorageDownloadTokens || verified.cacheControl !== "private, no-store") throw new PortalError("failed-precondition", "File verification failed. Please retry.");
      await staging.delete({ignoreNotFound: true});
      await db().runTransaction(async tx => {
        const current = await authorize(tx, memberRef, user, build); available(current);
        if (current.file?.id === uploadId) return;
        if (current.pending?.id !== uploadId || current.pending.status !== "uploading") throw new PortalError("failed-precondition", "This upload changed. Refresh the page.");
        tx.update(build, {...pending.fields, file: {id: uploadId, storagePath: pending.storagePath, filename: pending.filename, size: pending.size, generation: String(verified.generation)},
          pending: null, status: "ready", published: false, publishedAt: null, updatedAt: Date.now(),
          retiredPaths: [...(current.retiredPaths ?? []), ...(current.file ? [current.file.storagePath] : [])]});
        tx.create(db().collection("activity").doc(), audit(member.email, "Community upload verified", pending.fields, build.id));
      });
    } catch (error) {
      // A concurrent discard/delete must not leave a late copy behind. Never
      // remove a file that another completion has already made current.
      const current = (await build.get()).data();
      if (current?.file?.id !== uploadId && (!current || current.status === "deleting" || current.pending?.id !== uploadId || current.pending?.status === "deleting")) {
        await removeObjects([pending.uploadPath, pending.storagePath]);
      }
      throw error;
    }
    await cleanup(build);
    return {ok: true};
  }

  if (operation === "cancelCommunityUpload") {
    const uploadId = releaseId(data.uploadId);
    const pending = await db().runTransaction(async tx => {
      const record = await authorize(tx, memberRef, user, build); available(record);
      if (!record.pending || record.pending.id !== uploadId) throw new PortalError("failed-precondition", "This upload changed. Refresh the page.");
      tx.update(build, {"pending.status": "deleting", updatedAt: Date.now()}); return record.pending;
    });
    await removeObjects([pending.uploadPath, pending.storagePath]);
    await db().runTransaction(async tx => {
      const record = await authorize(tx, memberRef, user, build); available(record);
      if (record.pending?.id !== uploadId || record.pending?.status !== "deleting") throw new PortalError("failed-precondition", "This upload changed. Refresh the page.");
      tx.update(build, {pending: null, updatedAt: Date.now()});
      tx.create(db().collection("activity").doc(), audit(member.email, "Community upload discarded", record, build.id));
    });
    return {ok: true};
  }

  if (operation === "deleteCommunityBuild") {
    await db().runTransaction(async tx => {
      const record = await authorize(tx, memberRef, user, build);
      tx.update(build, {status: "deleting", published: false, publishedAt: null, updatedAt: Date.now()});
      tx.create(db().collection("activity").doc(), audit(member.email, "Community build removal started", record, build.id));
    });
    // Scope is derived only from the validated build ID, never a client path.
    await Promise.all([`community-files/${build.id}/`, `community-uploads/${build.id}/`].map(prefix => getStorage().bucket().deleteFiles({prefix, force: true})));
    await db().runTransaction(async tx => {
      const record = await authorize(tx, memberRef, user, build);
      if (record.status !== "deleting") throw new PortalError("failed-precondition", "The build changed. Refresh the page.");
      tx.delete(build);
      tx.create(db().collection("activity").doc(), audit(member.email, "Community build deleted", record, build.id));
    });
    return {ok: true};
  }
  throw new PortalError("invalid-argument", "Unknown community operation.");
}
