# Your own memory for Claude

This gives Claude a memory that follows you across conversations. It runs
entirely on **your own Cloudflare account** — your data never touches anyone
else. Setup is one click plus pasting one link into Claude. No coding, no
terminal.

---

## Step 1 — Deploy to your Cloudflare account

Click the button. If you do not have a Cloudflare account yet, you can create
a free one during this step.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sundown-barrows-3t/Bouios)

Cloudflare will:
1. Copy this project into your own GitHub account.
2. Create a database (named `memory-vault`) on your Cloudflare account.
3. Ask you to set one secret called **`BEARER_TOKEN`** — this is a password
   that protects your memory. Paste a long random value. If you have a terminal
   you can run `openssl rand -hex 32`; otherwise use any long random string of
   letters and numbers and **keep a copy**.
4. Deploy. When it finishes you get a web address ending in `.workers.dev` —
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
