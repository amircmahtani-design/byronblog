/* One-off: removes the second copy of "The Museum of Forgotten Things"
   (imported from Gmail on 18 August; the 1 August copy with the picture
   stays). It deletes only that one document, and only while it still has
   the exact title and Gmail message id it was published with, so calling
   it again, or by anyone, does nothing further. Delete this file once run. */
import admin from "firebase-admin";

const DOC = "WP8UBsM9idjmV3Ertkks";
const SRC = "19f7e356eb9f8e75";
const KEEP = "s64r5fL3DzQpwb7fGt0X";

function db(){
  const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if(creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  if(!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
  return admin.firestore();
}

export default async () => {
  let out;
  try{
    const store = db();
    const ref = store.collection("posts").doc(DOC);
    const [dup, keep] = await Promise.all([ref.get(), store.collection("posts").doc(KEEP).get()]);
    if(!dup.exists) out = { status:"already gone" };
    else if(!keep.exists) out = { status:"refused: the copy to keep is missing" };
    else if(dup.get("srcId") !== SRC || dup.get("title") !== "The Museum of Forgotten Things")
      out = { status:"refused: document does not match" };
    else { await store.recursiveDelete(ref); out = { status:"deleted", id:DOC }; }
  }catch(e){ out = { status:"error", error:String(e && e.message || e) }; }
  return new Response(JSON.stringify(out), { status:200, headers:{ "Content-Type":"application/json" } });
};
