# Set up your own sync store

Thunderegg Sync keeps your vault end-to-end encrypted across your Macs — and the encrypted copy
lives in **storage you own**, not on our servers. We never store, see, or pay for your files.

To make that true, you run a small relay (a "Worker") on your own free Cloudflare account, in
front of your own storage bucket. This guide walks you through it. **It's the advanced part of
Thunderegg** — you'll paste a handful of commands into Terminal — but it's a one-time setup of
about ten minutes, and when you're done you'll have something rare: cross-device sync where the
operator of the storage is *you*.

**What the relay can and cannot see.** File contents, file names, and folder structure are all
encrypted on your Mac before anything is uploaded. Your bucket holds hash-named encrypted blobs,
an encrypted manifest, and one small key file that contains your vault key only in *wrapped*
(encrypted) form — nothing in the bucket can be decrypted without your passphrase or recovery
key. Your passphrase never leaves your Mac.

**What it costs.** Cloudflare's free tiers cover a personal vault many times over (10 GB of R2
storage, 100,000 relay requests per day). Cloudflare may ask for a payment method when you enable
R2 — the storage product — even if you stay entirely inside the free tier.

---

## Before you start

You need:

- A **Cloudflare account** — free, [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
- **wrangler**, Cloudflare's command-line tool. In Terminal, one of:

  ```sh
  brew install cloudflare-wrangler
  ```

  or, if you have Node.js instead of Homebrew:

  ```sh
  npm install -g wrangler
  ```

- The relay itself: the `worker.js` file distributed alongside this guide — get both from
  [github.com/thunderegg-app/sync-store](https://github.com/thunderegg-app/sync-store)
  (the green **Code** button → **Download ZIP**, or `git clone`). It is one small file, and you
  can read every line of it before deploying.

## Step 1 — Log wrangler into your Cloudflare account

```sh
wrangler login
```

A browser window opens; approve the access. This authorizes *your* machine against *your*
account — no credentials go anywhere else.

## Step 2 — Make a folder for your relay

```sh
mkdir -p ~/thunderegg-sync-store && cd ~/thunderegg-sync-store
```

Copy `worker.js` into it — drag it in with Finder from the folder you downloaded, or:

```sh
cp ~/Downloads/sync-store-main/worker.js .
```

## Step 3 — Create your bucket and your key store

```sh
wrangler r2 bucket create thunderegg-sync
wrangler kv namespace create AUTH
```

The first command creates the storage bucket (if this is your first time using R2, Cloudflare's
dashboard will ask you to enable it). The second creates a tiny key-value store that holds your
access tokens, and **prints an `id`** — copy it, you need it in the next step.

## Step 4 — Write the config file

Create a file called `wrangler.toml` in the same folder, with exactly this content — pasting the
`id` from step 3 where marked:

```toml
name = "thunderegg-sync"
main = "worker.js"
compatibility_date = "2026-06-30"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "thunderegg-sync"

[[kv_namespaces]]
binding = "AUTH"
id = "PASTE-THE-ID-FROM-STEP-3-HERE"
```

## Step 5 — Deploy

```sh
wrangler deploy
```

If this is your first Worker, wrangler asks you to pick a `workers.dev` subdomain — choose
anything; it just becomes part of your URL. When the deploy finishes it prints your relay's
address, something like:

```
https://thunderegg-sync.yourname.workers.dev
```

**That URL is your Store URL.** Write it down.

## Step 6 — Mint your sync token

The token is the password to your relay. Generate a strong random one and register it:

```sh
TOK=$(openssl rand -hex 32)
wrangler kv key put --binding AUTH "tok:$TOK" '{"uid":"me","capBytes":10737418240}' --remote
echo "Your sync token: $TOK"
```

⚠️ **The `--remote` flag matters.** Without it, wrangler writes the token to a local simulator on
your Mac, reports success, and your deployed relay never sees it — every connection then fails
with "401". This has genuinely bitten people; if your token doesn't work, check this first.

**Write the token down** (it pastes into the app in the next step, and again on each additional
Mac). It's not your passphrase and it can't decrypt anything — it just controls who may read and
write the encrypted blobs — but treat it like a password.

## Step 7 — Check it works

```sh
curl -s -H "Authorization: Bearer $TOK" https://YOUR-STORE-URL/v1/list
```

You should see:

```
{"keys":[]}
```

An empty list — your store is up, authenticated, and empty, waiting for your vault.

## Step 8 — Point Thunderegg Sync at it

- **On your first Mac:** open Thunderegg Sync → **Set Up New Vault**. Choose your passphrase, and
  put your Store URL and sync token in the two optional fields. The app creates your vault's keys
  and publishes the wrapped key bundle into your store. Write down the recovery key it shows you —
  it is shown once and never again, unless you ticked the optional "escrow recovery key to my
  Keychain" box, which lets the menu re-show it on that Mac.
- **On every other Mac:** open Thunderegg Sync → **Join Existing Vault**. Enter the same Store
  URL and token, plus your passphrase (or the recovery key). Your vault downloads on the next sync.

That's it. Your Macs now converge through a relay you own, storing ciphertext in a bucket you own.

---

## Questions you might have

**Can I use Amazon S3 or Backblaze B2 instead?** Not currently — the app speaks to this relay,
and the relay runs on Cloudflare. The relay is a single small open file (`worker.js`) you can
read in full before deploying it.

**What if I lose the token?** Mint a new one (step 6 again) and remove the old:

```sh
wrangler kv key delete --binding AUTH "tok:OLD-TOKEN" --remote
```

Note: on a Mac that's already set up, the simplest way to switch to a new token today is to reset
Thunderegg Sync's data on that Mac and re-join with the new token and your passphrase. Your files
are untouched either way.

**What if I lose my passphrase?** The recovery key from setup is the only other way in for a new
device. If you lose both, no *new* device — and no third party, not us, not Cloudflare — can ever
unlock the synced copy; that is the zero-knowledge deal. Macs that are already set up keep
working (each holds the unlocked key in its own Keychain), so don't reset one in a panic — it may
be the last thing that can read your vault.

**Can two people share one relay?** Yes — mint a second token with a different `uid`
(`'{"uid":"partner","capBytes":10737418240}'`). Each `uid` is a fully separate, invisible-to-each-
other storage space under the same relay.

**What if I delete the Worker or the bucket?** You lose the synced copy, not your files — every
Mac keeps its full local vault. Redeploy (steps 4–5; your tokens live in the key store and
survive unless you deleted that too) and your Macs heal it themselves: on the next syncs they
republish the wrapped key bundle and re-upload the vault. No reset, no re-setup — in fact the app
will refuse a second Set Up on a configured Mac, by design.

**"That store already holds a vault"?** You clicked Set Up New Vault on a store that a vault
already lives in. Use Join Existing Vault instead — setting up new keys over it would strand the
existing files, which is why the app refuses.
