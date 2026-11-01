import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { makeEnv, req } from "./fakes.js";

const call = (env, method, path, opts) => worker.fetch(req(method, path, opts), env);
const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill);

describe("auth", () => {
  test("missing Authorization header -> 401", async () => {
    const r = await call(makeEnv(), "GET", "/v1/list", { token: null });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "unauthorized" });
  });

  test("non-Bearer scheme -> 401", async () => {
    const r = await call(makeEnv(), "GET", "/v1/list", {
      token: null,
      headers: { authorization: "Basic Zm9vOmJhcg==" },
    });
    assert.equal(r.status, 401);
  });

  test("unknown token -> 401", async () => {
    const r = await call(makeEnv(), "GET", "/v1/list", { token: "nope" });
    assert.equal(r.status, 401);
  });

  test("valid token, scheme is case-insensitive", async () => {
    const r = await call(makeEnv(), "GET", "/v1/list", {
      token: null,
      headers: { authorization: "bearer good" },
    });
    assert.equal(r.status, 200);
  });

  test("auth is checked before routing (unknown path without token is 401, not 404)", async () => {
    const r = await call(makeEnv(), "GET", "/whatever", { token: null });
    assert.equal(r.status, 401);
  });

  for (const uid of [undefined, "", "a/b", "..", ".", 42]) {
    test(`token record with unsafe uid ${JSON.stringify(uid)} is rejected (401)`, async () => {
      const env = makeEnv({ bad: { uid } });
      const r = await call(env, "GET", "/v1/list", { token: "bad" });
      assert.equal(r.status, 401);
    });
  }
});

describe("routing", () => {
  test("unknown path -> 404", async () => {
    const r = await call(makeEnv(), "GET", "/v2/list");
    assert.equal(r.status, 404);
  });

  test("unsupported method on object -> 404", async () => {
    const r = await call(makeEnv(), "POST", "/v1/o/keys.json", { body: "x" });
    assert.equal(r.status, 404);
  });

  test("responses are JSON", async () => {
    const r = await call(makeEnv(), "GET", "/v1/list");
    assert.equal(r.headers.get("content-type"), "application/json");
  });
});

describe("key validation", () => {
  for (const key of ["keys.json", "manifest.enc", "blobs/abc123", "blobs/deadbeef00"]) {
    test(`accepts ${key}`, async () => {
      const r = await call(makeEnv(), "PUT", `/v1/o/${key}`, { body: "x" });
      assert.equal(r.status, 200);
    });
  }

  test("empty key -> 400", async () => {
    const r = await call(makeEnv(), "GET", "/v1/o/");
    assert.equal(r.status, 400);
  });

  test("key with illegal characters -> 400", async () => {
    const r = await call(makeEnv(), "PUT", "/v1/o/blobs/a%20b", { body: "x" });
    assert.equal(r.status, 400);
  });

  test("over-long key -> 400", async () => {
    const r = await call(makeEnv(), "PUT", "/v1/o/" + "a".repeat(161), { body: "x" });
    assert.equal(r.status, 400);
  });

  test("key of exactly 160 chars is allowed", async () => {
    const r = await call(makeEnv(), "PUT", "/v1/o/" + "a".repeat(160), { body: "x" });
    assert.equal(r.status, 200);
  });

  test("encoded '..' inside a key -> 400", async () => {
    const r = await call(makeEnv(), "GET", "/v1/o/blobs/a..b");
    assert.equal(r.status, 400);
  });

  test("path traversal never escapes the user's prefix", async () => {
    const env = makeEnv({ good: { uid: "me" }, other: { uid: "other" } });
    await call(env, "PUT", "/v1/o/keys.json", { token: "other", body: "secret" });
    // URL normalisation collapses these; either way they must not reach u/other/.
    for (const p of ["/v1/o/../../u/other/keys.json", "/v1/o/%2e%2e/%2e%2e/u/other/keys.json"]) {
      const r = await call(env, "GET", p);
      assert.notEqual(r.status, 200, p);
    }
  });
});

describe("PUT / GET", () => {
  test("round-trips bytes exactly", async () => {
    const env = makeEnv();
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    const put = await call(env, "PUT", "/v1/o/blobs/ab", { body: data });
    assert.deepEqual(await put.json(), { ok: true, size: 5 });

    const get = await call(env, "GET", "/v1/o/blobs/ab");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(new Uint8Array(await get.arrayBuffer()), data);
  });

  test("objects are stored under u/<uid>/", async () => {
    const env = makeEnv();
    await call(env, "PUT", "/v1/o/manifest.enc", { body: "m" });
    assert.ok(env.BUCKET.store.has("u/me/manifest.enc"));
  });

  test("GET missing -> 404", async () => {
    const r = await call(makeEnv(), "GET", "/v1/o/blobs/missing");
    assert.equal(r.status, 404);
  });

  test("overwrite replaces content", async () => {
    const env = makeEnv();
    await call(env, "PUT", "/v1/o/manifest.enc", { body: "v1" });
    await call(env, "PUT", "/v1/o/manifest.enc", { body: "v2-longer" });
    const r = await call(env, "GET", "/v1/o/manifest.enc");
    assert.equal(await r.text(), "v2-longer");
  });

  test("empty body is allowed", async () => {
    const r = await call(makeEnv(), "PUT", "/v1/o/blobs/empty");
    assert.deepEqual(await r.json(), { ok: true, size: 0 });
  });
});

describe("storage cap", () => {
  test("upload that would exceed the cap -> 413 and nothing written", async () => {
    const env = makeEnv({ good: { uid: "me", capBytes: 10 } });
    const r = await call(env, "PUT", "/v1/o/blobs/big", { body: bytes(11) });
    assert.equal(r.status, 413);
    assert.equal(env.BUCKET.store.size, 0);
  });

  test("filling exactly to the cap is allowed", async () => {
    const env = makeEnv({ good: { uid: "me", capBytes: 10 } });
    assert.equal((await call(env, "PUT", "/v1/o/blobs/a", { body: bytes(6) })).status, 200);
    assert.equal((await call(env, "PUT", "/v1/o/blobs/b", { body: bytes(4) })).status, 200);
    assert.equal((await call(env, "PUT", "/v1/o/blobs/c", { body: bytes(1) })).status, 413);
  });

  test("cap is summed across paginated listings", async () => {
    const env = makeEnv({ good: { uid: "me", capBytes: 10 } }, { pageSize: 1 });
    for (const k of ["a", "b", "c"]) await call(env, "PUT", `/v1/o/blobs/${k}`, { body: bytes(3) });
    // 9 used across 3 pages; 2 more would be 11.
    assert.equal((await call(env, "PUT", "/v1/o/blobs/d", { body: bytes(2) })).status, 413);
  });

  test("overwriting with a same-size or smaller object is allowed even when at the cap", async () => {
    const env = makeEnv({ good: { uid: "me", capBytes: 10 } });
    await call(env, "PUT", "/v1/o/manifest.enc", { body: bytes(10) });
    assert.equal((await call(env, "PUT", "/v1/o/manifest.enc", { body: bytes(10) })).status, 200);
    assert.equal((await call(env, "PUT", "/v1/o/manifest.enc", { body: bytes(3) })).status, 200);
  });

  test("overwrite only charges the size difference", async () => {
    const env = makeEnv({ good: { uid: "me", capBytes: 10 } });
    await call(env, "PUT", "/v1/o/manifest.enc", { body: bytes(8) });
    assert.equal((await call(env, "PUT", "/v1/o/manifest.enc", { body: bytes(10) })).status, 200);
  });

  test("other users' data does not count against my cap", async () => {
    const env = makeEnv({ good: { uid: "me", capBytes: 10 }, p: { uid: "partner" } });
    await call(env, "PUT", "/v1/o/blobs/x", { token: "p", body: bytes(100) });
    assert.equal((await call(env, "PUT", "/v1/o/blobs/y", { body: bytes(10) })).status, 200);
  });

  test("default cap is 10 GiB when the token record omits capBytes", async () => {
    const env = makeEnv({ good: { uid: "me" } });
    // Pretend 10 GiB - 1 byte is already used, without allocating it.
    env.BUCKET.store.set("u/me/blobs/huge", { byteLength: 10 * 1024 ** 3 - 1, slice() { return this; } });
    assert.equal((await call(env, "PUT", "/v1/o/blobs/a", { body: bytes(1) })).status, 200);
    assert.equal((await call(env, "PUT", "/v1/o/blobs/b", { body: bytes(1) })).status, 413);
  });
});

describe("DELETE", () => {
  test("writes an empty tombstone and never removes the object", async () => {
    const env = makeEnv();
    await call(env, "PUT", "/v1/o/blobs/ab", { body: "data" });
    const r = await call(env, "DELETE", "/v1/o/blobs/ab");
    assert.deepEqual(await r.json(), { ok: true, tombstoned: true });
    assert.ok(env.BUCKET.store.has("u/me/blobs/ab"), "original kept");
    assert.equal(env.BUCKET.store.get("u/me/.tombstones/blobs/ab").byteLength, 0);
  });

  test("bad key -> 400", async () => {
    const r = await call(makeEnv(), "DELETE", "/v1/o/bad%20key");
    assert.equal(r.status, 400);
  });
});

describe("list", () => {
  test("empty store -> { keys: [] }", async () => {
    const r = await call(makeEnv(), "GET", "/v1/list");
    assert.deepEqual(await r.json(), { keys: [] });
  });

  test("returns keys without the user prefix, across pages, hiding tombstones", async () => {
    const env = makeEnv(undefined, { pageSize: 2 });
    for (const k of ["keys.json", "manifest.enc", "blobs/a", "blobs/b", "blobs/c"]) {
      await call(env, "PUT", `/v1/o/${k}`, { body: "x" });
    }
    await call(env, "DELETE", "/v1/o/blobs/c");
    const { keys } = await (await call(env, "GET", "/v1/list")).json();
    assert.deepEqual(keys.sort(), ["blobs/a", "blobs/b", "blobs/c", "keys.json", "manifest.enc"]);
  });
});

describe("tenant isolation", () => {
  test("users cannot see or read each other's objects", async () => {
    const env = makeEnv({ good: { uid: "me" }, p: { uid: "partner" } });
    await call(env, "PUT", "/v1/o/keys.json", { token: "p", body: "partner-keys" });

    const list = await (await call(env, "GET", "/v1/list")).json();
    assert.deepEqual(list.keys, []);
    assert.equal((await call(env, "GET", "/v1/o/keys.json")).status, 404);
  });

  test("regression: uid 'a/b' cannot nest inside uid 'a' and be read by it", async () => {
    const env = makeEnv({ a: { uid: "a" }, ab: { uid: "a/b" } });
    const put = await call(env, "PUT", "/v1/o/keys.json", { token: "ab", body: "B's key" });
    assert.equal(put.status, 401, "unsafe uid is refused, so nothing lands under u/a/");
    const list = await (await call(env, "GET", "/v1/list", { token: "a" })).json();
    assert.deepEqual(list.keys, []);
  });

  test("typical uids from the setup guide still work", async () => {
    for (const uid of ["me", "partner", "user_2", "Alice-01", "a.b"]) {
      const env = makeEnv({ t: { uid } });
      assert.equal((await call(env, "GET", "/v1/list", { token: "t" })).status, 200, uid);
    }
  });

  test("a uid that is a prefix of another uid does not leak (me vs me2)", async () => {
    const env = makeEnv({ good: { uid: "me" }, two: { uid: "me2" } });
    await call(env, "PUT", "/v1/o/keys.json", { token: "two", body: "x" });
    assert.deepEqual((await (await call(env, "GET", "/v1/list")).json()).keys, []);
  });
});
