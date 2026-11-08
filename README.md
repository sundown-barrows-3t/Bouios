# Bouios - your AI picks up exactly where you left off

Bouios gives Claude a memory that lives in your own account and follows you
across every chat, every Code session and every device, so you never
re-explain your project again.

It keeps a live, queryable record of your projects, decisions and open tasks in
your own backend, so Claude stays consistent across Claude Chat, Claude Code,
Cowork and any device. It works on any Claude plan, including Claude Free.

- Site: https://bouios.syndakat.com
- Start the free 7-day trial: https://bouios.syndakat.com/join?plan=trial
- Levels and checkout: https://bouios.syndakat.com/#pricing
- Contact: https://syndakat.com/contact

This repository is the thin worker that runs in your own Cloudflare account.
You deploy it with one button and paste one link into Claude. No coding.

---

## Why Bouios

- **Continuity across surfaces.** Claude Chat, Claude Code, Cowork and any
  device share the same context. Switching from a chat to a Code session no
  longer wipes what you were doing.
- **You own your data.** Your memory lives in your own account, in a standard
  database you can export, move or delete. Bouios's own rules and licence check
  come from our service.
- **Fewer confident wrong answers.** Bouios makes Claude check its memory
  before it answers. In a same-model test, a fresh session got project-specific
  decisions 0/9 right; a continued one got 9/9. This is a small-sample,
  directional result.
- **Capability that compounds.** Skills and patterns accumulate across sessions.

---

## Levels

Start free, then choose a level. Prices are shown at checkout:
https://bouios.syndakat.com/#pricing

| Level | What you get |
|-------|--------------|
| **Trial Herder** | Free for 7 days with everything in Max Herder. Persistent memory in your own account. Unlimited skills (6 ready-made). |
| **Herder** | For light use. 1 project. Up to 5 skills (5 ready-made). 3-day chat history. No-marks scanning, plus one free clean or edit. |
| **Pro Herder** | For solo work across projects. Unlimited projects. Up to 10 skills (5 ready-made). 7-day chat history. No-marks scanning, plus one free clean or edit. |
| **Max Herder** | For heavy work across projects. Everything in Pro. 30-day chat history. Unlimited skills (6 ready-made). Audit trail: a log of decisions and saves in your own memory. No-marks, which herds your AI's output too, checking and cleaning what it writes before you publish. |

Every level works on every surface (Claude Chat, Code and Cowork).

### How to upgrade

Choose a level and check out at https://bouios.syndakat.com/#pricing. After
checkout we email you a licence key. Add it to your own Bouios setup as a
setting named `LICENCE` (Step 4 below). Nothing is reinstalled and your memory
stays as it is. Moving to a higher level works the same way: the new key
replaces the old one.

Bouios is in alpha. To request access, use the form on the site.

---

## Step 1 - Deploy to your Cloudflare account

Before you start: open Cloudflare's dashboard, go to Storage & databases > R2
and turn R2 on (it is free to start). Without it the deploy cannot create your
chat-backup bucket.

Click the button. If you do not have a Cloudflare account yet, you can create a
free one during this step.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sundown-barrows-3t/Bouios)

Cloudflare will:
1. Copy this project into your own GitHub account.
2. Create a database (named `memory-vault`) on your Cloudflare account.
3. Create a storage bucket (named `memory-vault-transcripts`) for your chat
   backups.
4. Ask you to set one secret called **`BEARER_TOKEN`**. This is a password that
   protects your memory. Paste a long random value. If you have a terminal you
   can run `openssl rand -hex 32`; otherwise use any long random string of
   letters and numbers and **keep a copy**.
5. Deploy. When it finishes you get a web address ending in `.workers.dev`, for
   example `https://memory-vault.yourname.workers.dev`. **Copy it.**

The database tables are created automatically on first use. There is nothing
else to run.

---

## Step 2 - Connect it to Claude

1. Go to **claude.ai > Settings > Connectors > Add custom connector**.
2. For the URL, join your Worker address, `/mcp/`, and your token:

   ```
   https://memory-vault.yourname.workers.dev/mcp/YOUR_BEARER_TOKEN
   ```

   Use the address from Step 1 and the token you set in Step 1.
3. Save.

Claude Free allows one custom connector, which is all you need.

---

## Step 3 - Use it

In any chat, type:

```
load memory
```

Claude loads your saved context, decisions and open tasks. As you work it saves
back automatically and, when a chat gets long, hands you a short block to paste
into a new chat so nothing is lost.

---

## Step 4 - Add your licence key

Your licence key comes by email when you finish the checkout (free with the
alpha code during the alpha). Memory works without it; the key switches on what
your level includes.

In the Cloudflare dashboard open **Workers & Pages**, your `memory-vault`
worker, **Settings > Variables and Secrets > Add**, choose type **Secret**, name
it **`LICENCE`**, paste the key and deploy.

---

## What is kept in your storage

- **Chat and Cowork:** your worker keeps a record of each Bouios call made in a
  chat (load, save and the rest, with a short copy of each answer) in your own
  bucket. It is not the whole conversation: your worker only sees the Bouios
  calls.
- **Claude Code:** the whole chat, with the optional step below.

---

## Optional: back up your Claude Code chats

On the machine where you use Claude Code, run:

    bash hooks/install-transcript-hook.sh https://<your-address>.workers.dev <your BEARER_TOKEN>

Each Claude Code chat is then saved to your own storage when it ends or
compacts. Nothing is sent anywhere else.

---

## Planned (not built yet)

- **Prompt caching** in the console add-on, so repeated context costs less.
- **Batch mode** in the console add-on for bulk jobs at the batch discount, on
  your own key.
- **Usage notes** that show your plan's usage limits rather than dollar costs on
  Pro and Max.
- **A new chat at the hand-off point**, opened for you with your saved state.
- **Take your memory to a different AI.** It works with Claude today.

---

## Questions

- **Is it really free?** The 7-day trial is free. After that, choose a level at
  https://bouios.syndakat.com/#pricing. Cloudflare's free tier covers normal
  personal use of the worker itself.
- **Can I move my data?** It is a standard database on your account. It is
  yours, and cancelling a subscription does not delete anything.
- **What if I lose my token?** Set a new `BEARER_TOKEN` secret in the
  Cloudflare dashboard and update your connector URL.
- **Does it work with other assistants?** Today it works with Claude across all
  surfaces. Other assistants are on the roadmap.

---

## Licence

Elastic License 2.0. See [LICENSE](LICENSE).

A product of [Syndakat](https://syndakat.com).
