# Testing

The tests use Node's built-in test runner — **no packages to install**, no Cloudflare account,
no network. Cloudflare's R2 bucket and KV store are replaced by small in-memory fakes
(`test/fakes.js`), so nothing ever talks to a real service or needs a real token.

## Run

Requires Node.js 20 or newer.

```sh
npm test
```

(or, without npm: `node --test "test/*.test.js"`)

## What's covered

- `test/worker.test.js` — unit tests for `worker.js`: auth (missing/wrong/unknown tokens,
  unsafe `uid` values), routing, key validation and path traversal, PUT/GET round-trips,
  the storage cap (including overwrites and paginated listings), DELETE tombstones, `/v1/list`,
  and isolation between users.
- `test/flow.test.js` — an end-to-end walk-through of the client's real sequence (set up on one
  Mac, join on a second, edit, delete) against a single in-memory relay.

## Not covered

The tests call `worker.fetch()` directly with Node's standard `Request`/`Response`; they don't
run inside Cloudflare's actual runtime (workerd/miniflare). Behaviour that depends on real R2
specifics — e.g. concurrent writes racing the storage cap — isn't exercised.

`package.json` exists only for `npm test`. Deploying still needs just `worker.js` + `wrangler.toml`.
