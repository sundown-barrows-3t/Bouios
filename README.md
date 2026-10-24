# Your own memory for Claude

This gives Claude a memory that follows you across conversations. It runs
entirely on **your own Cloudflare account** — your data never touches anyone
else. Setup is one click plus pasting one link into Claude. No coding, no
terminal.

---

## Step 1 — Deploy to your Cloudflare account

Before you start: open Cloudflare's dashboard, go to Storage & databases > R2 and turn R2 on (it is free to start). Without it the deploy cannot create your chat-backup bucket.

Click the button. If you do not have a Cloudflare account yet, you can create
a free one during this step.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sundown-barrows-3t/Bouios)

Cloudflare will:
1. Copy this project into your own GitHub account.
2. Create a database (named `memory-vault`) on your Cloudflare account.
3. Create a storage bucket (named `memory-vault-transcripts`) for your chat backups.
4. Ask you to set one secret called **`BEARER_TOKEN`** — this is a password
   that protects your memory. Paste a long random value. If you have a terminal
   you can run `openssl rand -hex 32`; otherwise use any long random string of
   letters and numbers and **keep a copy**.
5. Deploy. When it finishes you get a web address ending in `.workers.dev` —
   for example `https://memory-vault.yourname.workers.dev`. **Copy it.**

The database tables are created automatically on first use. There is nothing
else to run.

---

## Step 2 — Connect it to Claude

Works on any Claude plan, including **Claude Free** (one connector allowed).

1. Go to **claude.ai → Settings → Connectors → Add custom connector**.
2. For the URL, join your Worker address, `/mcp/`, and your token:

   ```
   https://memory-vault.yourname.workers.dev/mcp/YOUR_BEARER_TOKEN
   ```

   Use the address from Step 1 and the token you set in Step 1.
3. Save.

---

## Step 3 — Use it

In any chat, type:

```
load memory
```

Claude loads your saved context, decisions, and open tasks. As you work it
saves back automatically and, when a chat gets long, hands you a short block to
paste into a new chat so nothing is lost.

---

## Step 4 — Add your licence key

Your licence key comes by email when you finish the checkout (free with the
alpha code during the alpha). Memory works without it; the key switches on
what your level includes.

In the Cloudflare dashboard open **Workers & Pages**, your `memory-vault`
worker, **Settings → Variables and Secrets → Add**, choose type **Secret**,
name it **`LICENCE`**, paste the key and deploy.

---

## What is kept in your storage

- **Chat and Cowork:** your worker keeps a record of each Bouios call made in
  a chat (load, save and the rest, with a short copy of each answer) in your
  own bucket. It is not the whole conversation: your worker only sees the
  Bouios calls. If you have a terminal you can list them with
  `curl -H "Authorization: Bearer YOUR_BEARER_TOKEN" https://memory-vault.yourname.workers.dev/chat`.
- **Claude Code:** the whole chat, with the optional step below.

---

## Optional: keep your chat transcripts (needs storage on your account)

The button sets up your memory without chat storage, so memory works on any
account. To keep chat transcripts, add storage as a second step. You need R2
storage switched on in your Cloudflare account. This step checks that first and,
if it is not on, tells you how to switch it on and changes nothing.

In a terminal, with a Cloudflare API token that can edit Workers and R2 storage:

    CLOUDFLARE_API_TOKEN=<your token> WORKER_URL=https://<your-address>.workers.dev BEARER_TOKEN=<your BEARER_TOKEN> bash hooks/add-transcript-storage.sh

It creates the bucket, adds it to your worker (your existing settings and secrets
are kept), sets up the Claude Code backup below, and then stores a small test file
and reads it back so you can see it works. Run it again at any time: nothing is
added twice. If your worker is not called `memory-vault`, add
`WORKER_NAME=<your worker name>`. If your token can see more than one account, add
`CLOUDFLARE_ACCOUNT_ID=<your account id>`.

---

## Optional: back up your Claude Code chats

The step above already does this. To do only this part, in a terminal on the
machine where you use Claude Code, run:

    bash hooks/install-transcript-hook.sh https://<your-address>.workers.dev <your BEARER_TOKEN>

Each Claude Code chat is then saved to your own storage when it ends or compacts. Nothing is sent anywhere else.

---

## What you get

- **Cross-chat continuity** — Claude picks up where you left off.
- **Your data, your account** — everything lives in your Cloudflare database.
- **One password** — the `BEARER_TOKEN` is the only key. Rotate it any time in
  the Cloudflare dashboard.

## Questions

- **Is it really free?** Cloudflare's free tier covers normal personal use.
- **Can I move my data?** It is a standard database on your account. It is yours.
- **What if I lose my token?** Set a new `BEARER_TOKEN` secret in the Cloudflare
  dashboard and update your connector URL.
