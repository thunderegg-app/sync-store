/**
 * Thunderegg Sync — zero-knowledge blob backend (Cloudflare Worker + R2).
 *
 * Stores/serves ONLY opaque encrypted objects: hashed-name blobs, the encrypted manifest, and a
 * keys.json that holds the vault key in WRAPPED form. The server can never read vault content or
 * filenames — auth identifies the *account* (a per-user key prefix), it does not (and cannot) read
 * plaintext, because there is none server-side. This is the "own a thin R2 backend" fork realized.
 *
 * HTTP API (client = spike/r2store.py):
 *   GET    /v1/list            -> { keys: [...] }            (for pull)
 *   GET    /v1/o/<key>         -> object bytes | 404
 *   PUT    /v1/o/<key>         -> { ok, size }               (413 if over the storage cap)
 *   DELETE /v1/o/<key>         -> { ok, tombstoned }         (never hard-delete: writes a tombstone)
 *
 * Auth: `Authorization: Bearer <token>`; AUTH KV maps `tok:<token>` -> {uid, capBytes}.
 *
 * SKELETON vs PRODUCTION (honest): this is deploy-ready and correct for a first backend, but two
 * things are simplified and MUST harden before charging money — both flagged inline:
 *   (1) the storage cap is computed by listing (fine at MVP scale; production = a usage counter in
 *       a Durable Object / D1 to avoid an O(objects) list per PUT), and
 *   (2) large binary sidecars should move to *presigned direct-to-R2* PUT/GET (PLAN §5) to offload
 *       Worker bandwidth/CPU — small Markdown blobs are fine proxied through the Worker.
 */

const MAX_KEY = 160;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function authUser(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const rec = await env.AUTH.get("tok:" + m[1], "json");
  if (!rec) return null;
  // The uid becomes the storage prefix `u/<uid>/`, so it must be exactly one safe path segment.
  // A missing uid would share "u/undefined/" across tokens, and a uid containing "/" (e.g. "a/b")
  // would sit inside another user's prefix ("u/a/") and be readable by them. Fail closed.
  if (typeof rec.uid !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(rec.uid)) return null;
  return { uid: rec.uid, capBytes: rec.capBytes ?? 10 * 1024 * 1024 * 1024 }; // default 10 GiB
}

// Client keys are only: "keys.json", "manifest.enc", "blobs/<hex>". Reject traversal + junk.
function safeKey(k) {
  if (!k || k.length > MAX_KEY) return null;
  if (k.includes("..") || k.startsWith("/")) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(k)) return null;
  return k;
}

async function usageBytes(env, prefix) {
  // SKELETON cap check — production: replace with a maintained counter (Durable Object / D1).
  let total = 0, cursor;
  do {
    const r = await env.BUCKET.list({ prefix, cursor });
    for (const o of r.objects) total += o.size;
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return total;
}

export default {
  async fetch(req, env) {
    const user = await authUser(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    const parts = new URL(req.url).pathname.replace(/^\/+/, "").split("/");
    const prefix = `u/${user.uid}/`;

    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "list") {
      const keys = [];
      let cursor;
      do {
        const r = await env.BUCKET.list({ prefix, cursor });
        for (const o of r.objects) {
          const k = o.key.slice(prefix.length);
          if (!k.startsWith(".tombstones/")) keys.push(k);
        }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      return json({ keys });
    }

    if (parts[0] === "v1" && parts[1] === "o") {
      const key = safeKey(parts.slice(2).join("/"));
      if (!key) return json({ error: "bad key" }, 400);
      const full = prefix + key;

      if (req.method === "GET") {
        const obj = await env.BUCKET.get(full);
        if (!obj) return json({ error: "not found" }, 404);
        return new Response(obj.body, {
          headers: { "content-type": "application/octet-stream" },
        });
      }

      if (req.method === "PUT") {
        const body = await req.arrayBuffer();
        const existing = await env.BUCKET.head(full);
        const delta = body.byteLength - (existing ? existing.size : 0);
        if (delta > 0 && (await usageBytes(env, prefix)) + delta > user.capBytes) {
          return json({ error: "storage cap exceeded" }, 413);
        }
        await env.BUCKET.put(full, body);
        return json({ ok: true, size: body.byteLength });
      }

      if (req.method === "DELETE") {
        // Never hard-delete a committed byte: write a tombstone; the client GCs after a grace window.
        await env.BUCKET.put(prefix + ".tombstones/" + key, new Uint8Array(0));
        return json({ ok: true, tombstoned: true });
      }
    }

    return json({ error: "not found" }, 404);
  },
};
