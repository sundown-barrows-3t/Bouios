# Console chat page

A small chat page of your own. It uses your Anthropic Console credit and can attach your Bouios memory
and your GitHub repositories as tools. Your chat history stays in your browser; nothing is stored on the
service itself.

## Settings

Set these on your own service as secrets. The page reads these five and nothing else:

- `ANTHROPIC_KEY`: your Anthropic Console API key (required).
- `GATEWAY_TOKEN`: a long random page key that you choose and keep (required).
- `MEMORY_URL`: your own memory address including your token. If it is not set, the memory tool is off.
- `LICENCE`: your Bouios licence key. See "Licence" below.
- `GITHUB_TOKEN`: optional. Lets the page reach your GitHub repositories.

## Install on your own account

1. Create a new service named `console-gateway` on your account, paste in the contents of `worker.js`
   from this folder, and deploy it.
2. Add the settings above as secrets. `ANTHROPIC_KEY` and `GATEWAY_TOKEN` are needed for the page to work;
   add `MEMORY_URL` and `LICENCE` for memory, and `GITHUB_TOKEN` if you want your repositories.
3. Open the new service's web address. Type your `GATEWAY_TOKEN` when the page asks, pick a model and chat.

## Licence

When `MEMORY_URL` and `LICENCE` are both set, the memory tool is attached only if your licence verifies
with Bouios (`/licence/verify`). The answer is kept for five minutes. If it does not verify, or the check
cannot be completed, the memory tool is left off for that message and the page tells you plainly that the
licence did not verify. Your licence is never put into a message sent to the model.

With no `LICENCE` set, the memory tool is attached whenever `MEMORY_URL` is set, so a copy made before
licences existed keeps working.

## Notes

- Calls to the page's `/v1/` address need your `GATEWAY_TOKEN`. The chat page itself loads without it.
- Keep your settings to yourself: anyone holding your `GATEWAY_TOKEN` can chat on your Console credit.
