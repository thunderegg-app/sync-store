// Integration-style test: walks the same sequence of calls the Thunderegg client makes
// (setup on Mac A, join on Mac B, edit, delete) against one in-memory relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { makeEnv, req } from "./fakes.js";

test("two devices converge through the relay", async () => {
  const env = makeEnv({ macA: { uid: "me" }, macB: { uid: "me" } }, { pageSize: 3 });
  const A = (m, p, body) => worker.fetch(req(m, p, { token: "macA", body }), env);
  const B = (m, p, body) => worker.fetch(req(m, p, { token: "macB", body }), env);

  // Mac A: fresh store, publish wrapped keys + manifest + blobs.
  assert.deepEqual(await (await A("GET", "/v1/list")).json(), { keys: [] });
  await A("PUT", "/v1/o/keys.json", '{"wrapped":"..."}');
  for (let i = 0; i < 5; i++) await A("PUT", `/v1/o/blobs/${i.toString(16).padStart(4, "0")}`, `ct${i}`);
  await A("PUT", "/v1/o/manifest.enc", "manifest-v1");

  // Mac B: joins with a different token for the same uid and pulls everything.
  const { keys } = await (await B("GET", "/v1/list")).json();
  assert.equal(keys.length, 7);
  for (const k of keys) assert.equal((await B("GET", `/v1/o/${k}`)).status, 200);
  assert.equal(await (await B("GET", "/v1/o/manifest.enc")).text(), "manifest-v1");

  // Mac B edits and deletes; Mac A sees the new manifest and the deleted blob is tombstoned, not lost.
  await B("PUT", "/v1/o/manifest.enc", "manifest-v2");
  await B("DELETE", "/v1/o/blobs/0000");
  assert.equal(await (await A("GET", "/v1/o/manifest.enc")).text(), "manifest-v2");
  assert.equal(await (await A("GET", "/v1/o/blobs/0000")).text(), "ct0");
  assert.equal(await (await A("GET", "/v1/o/.tombstones/blobs/0000")).text(), "");
});
