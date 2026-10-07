import {getFirestore, type DocumentData, type DocumentReference, type Transaction} from "firebase-admin/firestore";
import {assertAccess, PortalError, type Identity, type Member} from "./domain.js";
import {enhancementFields, enhancementId, enhancementReview} from "./enhancement-domain.js";

export const ENHANCEMENT_CUSTOMER_OPERATIONS = new Set(["enhancementRequests", "submitEnhancement", "setEnhancementLike"]);
export const ENHANCEMENT_OPERATIONS = new Set([...ENHANCEMENT_CUSTOMER_OPERATIONS, "reviewEnhancement"]);
const db = () => getFirestore();
const requests = () => db().collection("enhancementRequests");
const publicRequest = (record: DocumentData, id: string, uid: string, liked: boolean) => ({
  id, title: record.title, description: record.description, status: record.status, statusNote: record.statusNote,
  createdAt: record.createdAt, statusUpdatedAt: record.statusUpdatedAt, reviewVersion: record.reviewVersion,
  likeCount: record.likeCount, liked, mine: record.createdBy === uid,
});

async function authorize(tx: Transaction, memberRef: DocumentReference, user: Identity, admin = false) {
  return assertAccess(user, (await tx.get(memberRef)).data() as Member | undefined, admin);
}

export async function enhancementDispatch(operation: string, data: Record<string, unknown>, user: Identity, memberRef: DocumentReference): Promise<unknown> {
  if (operation === "enhancementRequests") {
    const sort = data.sort ?? "newest";
    if (sort !== "newest" && sort !== "popular") throw new PortalError("invalid-argument", "Choose newest or most liked.");
    // Single-field sorting uses automatic indexes. Status/search filtering is
    // explicitly limited to loaded results in the UI, avoiding new index setup.
    let query = requests().orderBy(sort === "popular" ? "likeCount" : "createdAt", "desc");
    if (data.cursor) {
      const snapshot = await requests().doc(enhancementId(data.cursor)).get();
      if (!snapshot.exists) throw new PortalError("invalid-argument", "The request list changed. Refresh and try again.");
      query = query.startAfter(snapshot);
    }
    const result = await query.limit(51).get();
    const docs = result.docs.slice(0, 50);
    const likes = docs.length ? await db().getAll(...docs.map(doc => doc.ref.collection("likes").doc(user.uid))) : [];
    return {items: docs.map((doc, index) => publicRequest(doc.data(), doc.id, user.uid, likes[index].exists)), next: result.size > 50 ? docs[49].id : null};
  }

  const request = requests().doc(enhancementId(data.id));
  if (operation === "submitEnhancement") {
    const fields = enhancementFields(data);
    return db().runTransaction(async tx => {
      const member = await authorize(tx, memberRef, user);
      const existing = await tx.get(request);
      if (existing.exists) {
        // A retry after a lost response must not create a duplicate request or
        // overwrite a review/likes. The browser reuses one ID per submission.
        if (existing.get("createdBy") !== user.uid || existing.get("title") !== fields.title || existing.get("description") !== fields.description) {
          throw new PortalError("failed-precondition", "This submission already exists. Refresh and try again.");
        }
        return {id: request.id};
      }
      const record = {...fields, createdBy: user.uid, createdAt: Date.now(), status: "Pending Review", statusNote: "",
        statusUpdatedAt: null, reviewVersion: 0, likeCount: 0};
      tx.create(request, record);
      tx.create(db().collection("activity").doc(), {actor: member.email, uid: user.uid, action: "Enhancement submitted", target: fields.title, requestId: request.id, createdAt: Date.now()});
      return {id: request.id};
    });
  }

  if (operation === "setEnhancementLike") {
    if (typeof data.liked !== "boolean") throw new PortalError("invalid-argument", "Choose whether to like this request.");
    const vote = request.collection("likes").doc(user.uid);
    return db().runTransaction(async tx => {
      await authorize(tx, memberRef, user);
      const [snapshot, existing] = await tx.getAll(request, vote);
      if (!snapshot.exists) throw new PortalError("not-found", "Enhancement request not found.");
      const count = snapshot.get("likeCount") as number;
      if (data.liked === existing.exists) return {liked: existing.exists, likeCount: count};
      const likeCount = Math.max(0, count + (data.liked ? 1 : -1));
      if (data.liked) tx.create(vote, {createdAt: Date.now()}); else tx.delete(vote);
      tx.update(request, {likeCount});
      return {liked: data.liked, likeCount};
    });
  }

  if (operation === "reviewEnhancement") {
    const review = enhancementReview(data);
    return db().runTransaction(async tx => {
      const member = await authorize(tx, memberRef, user, true);
      const snapshot = await tx.get(request);
      if (!snapshot.exists) throw new PortalError("not-found", "Enhancement request not found.");
      if (snapshot.get("reviewVersion") !== review.reviewVersion) throw new PortalError("failed-precondition", "This status was updated in another session. Refresh the list, review the latest note, then try again.");
      const changes = {status: review.status, statusNote: review.statusNote, reviewVersion: review.reviewVersion + 1, statusUpdatedAt: Date.now()};
      tx.update(request, changes);
      tx.create(db().collection("activity").doc(), {actor: member.email, uid: user.uid, action: "Enhancement status updated", target: snapshot.get("title"),
        requestId: request.id, previousStatus: snapshot.get("status"), status: review.status, createdAt: Date.now()});
      return changes;
    });
  }
  throw new PortalError("invalid-argument", "Unknown enhancement operation.");
}
