# Thunderegg Sync — self-hosted sync store

The storage relay for [Thunderegg](https://thunderegg.ai) Sync (in development): a small
Cloudflare Worker you deploy on your **own** free Cloudflare account, in front of your **own**
R2 bucket, so your encrypted vault syncs through infrastructure you own. The relay only ever
stores ciphertext — it cannot read your files, your file names, or your folder structure, and
neither can we, because it doesn't run on our servers at all.

- **[SETUP-SYNC-STORE.md](SETUP-SYNC-STORE.md)** — the setup guide (~10 minutes, one-time).
- **[worker.js](worker.js)** — the relay itself. One file; read every line before you deploy it.

This repo is the published mirror of the relay + guide from Thunderegg's private development
tree (currently matching `sync-v0.9`). MIT licensed.
