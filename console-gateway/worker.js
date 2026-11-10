const PAGE = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Console chat</title>\n<style>\n:root{--bg:#fafaf8;--fg:#1c1c1a;--mut:#6b6b66;--card:#fff;--bd:#dcdcd6;--acc:#8a4b2a;--you:#efe9e1}\n@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae4;--mut:#9a988f;--card:#1f1f1c;--bd:#33332f;--acc:#d08a5e;--you:#2a2824}}\n*{box-sizing:border-box}html,body{height:100%;margin:0}\nbody{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:flex;flex-direction:column}\nheader{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--bd)}\nheader h1{font-size:16px;margin:0;flex:1}\nselect,button,textarea,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:8px 10px}\nbutton{cursor:pointer;background:var(--acc);color:#fff;border-color:var(--acc)}\nbutton.ghost{background:transparent;color:var(--mut);border-color:var(--bd)}\nmain{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}\n.msg{max-width:46rem;padding:10px 14px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;border:1px solid var(--bd);background:var(--card)}\n.msg.user{background:var(--you);align-self:flex-end}\n.note{color:var(--mut);font-size:14px}\nform{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--bd)}\ntextarea{flex:1;resize:none;min-height:44px;max-height:30vh}\n#gate{padding:16px;display:none;gap:8px;flex-wrap:wrap}\n#gate input{flex:1;min-width:200px}\n</style></head><body>\n<header><h1>Console chat</h1>\n<select id=\"model\" aria-label=\"Model\"><option value=\"claude-sonnet-5-5\">Sonnet 5.5</option><option value=\"claude-opus-5-5\">Opus 5.5</option><option value=\"claude-haiku-5-5\">Haiku 5.5</option><option value=\"claude-fable-5-1\">Fable 5.1</option></select>\n<button class=\"ghost\" id=\"clear\" type=\"button\">New chat</button></header>\n<div id=\"gate\"><input id=\"tok\" type=\"password\" placeholder=\"Gateway token\" autocomplete=\"off\"><button id=\"save\" type=\"button\">Unlock</button></div>\n<main id=\"log\"><div class=\"note\">Chat on your Console credits, with your GitHub repos and your own memory when they are set on the gateway.</div></main>\n<form id=\"f\"><textarea id=\"in\" rows=\"1\" placeholder=\"Message\" aria-label=\"Message\"></textarea><button id=\"go\" type=\"submit\">Send</button></form>\n<script>\nvar token=\"\",hist=[];\nvar log=document.getElementById(\"log\"),inp=document.getElementById(\"in\"),gate=document.getElementById(\"gate\"),model=document.getElementById(\"model\");\ntry{token=sessionStorage.getItem(\"gw\")||\"\";}catch(e){}\nfunction showGate(){gate.style.display=token?\"none\":\"flex\";}\nshowGate();\ndocument.getElementById(\"save\").onclick=function(){token=document.getElementById(\"tok\").value.trim();try{sessionStorage.setItem(\"gw\",token);}catch(e){}document.getElementById(\"tok\").value=\"\";showGate();};\ndocument.getElementById(\"clear\").onclick=function(){hist=[];log.textContent=\"\";var d=document.createElement(\"div\");d.className=\"note\";d.textContent=\"New chat.\";log.appendChild(d);};\nfunction add(role,text){var d=document.createElement(\"div\");d.className=\"msg \"+role;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}\ndocument.getElementById(\"f\").onsubmit=async function(ev){\n  ev.preventDefault();\n  var text=inp.value.trim();if(!text)return;\n  if(!token){showGate();return;}\n  inp.value=\"\";hist.push({role:\"user\",content:text});add(\"user\",text);\n  var b=add(\"assistant\",\"...\");var out=\"\";\n  try{\n    var res=await fetch(\"/v1/messages\",{method:\"POST\",headers:{\"content-type\":\"application/json\",\"authorization\":\"Bearer \"+token,\"anthropic-version\":\"2023-06-01\",\"x-gw-tools\":\"1\"},body:JSON.stringify({model:model.value,max_tokens:4096,stream:true,messages:hist})});\n    if(!res.ok){var t=await res.text();b.textContent=\"Error \"+res.status+\": \"+t;hist.pop();if(res.status===401){token=\"\";try{sessionStorage.removeItem(\"gw\");}catch(e){}showGate();}return;}\n    var rd=res.body.getReader(),dec=new TextDecoder(),buf=\"\";\n    for(;;){\n      var r=await rd.read();if(r.done)break;\n      buf+=dec.decode(r.value,{stream:true});\n      var parts=buf.split(\"\\n\\n\");buf=parts.pop();\n      for(var i=0;i<parts.length;i++){\n        var line=parts[i].split(\"\\n\").find(function(l){return l.indexOf(\"data: \")===0;});\n        if(!line)continue;\n        try{var e2=JSON.parse(line.slice(6));\n          if(e2.type===\"content_block_start\"&&e2.content_block&&e2.content_block.type===\"mcp_tool_use\"){out+=\"\\n[using \"+(e2.content_block.server_name||\"tool\")+\": \"+(e2.content_block.name||\"\")+\"]\\n\";b.textContent=out;}\n          if(e2.type===\"content_block_delta\"&&e2.delta&&e2.delta.type===\"text_delta\"){out+=e2.delta.text;b.textContent=out;log.scrollTop=log.scrollHeight;}\n          if(e2.type===\"error\"){b.textContent=\"Error: \"+JSON.stringify(e2.error);}\n        }catch(x){}\n      }\n    }\n    hist.push({role:\"assistant\",content:out});\n  }catch(err){b.textContent=\"Network error: \"+err;hist.pop();}\n};\ninp.addEventListener(\"keydown\",function(e){if(e.key===\"Enter\"&&!e.shiftKey&&!e.isComposing){e.preventDefault();document.getElementById(\"f\").requestSubmit();}});\n</script></body></html>";

// Settings this worker reads, all the installer's own (README.md). No other env value is read.
// MEMORY_URL: the installer's own memory worker URL including their token (INSTALL.md, Layer 3). Default none: the memory tool is off.
// LICENCE: your Bouios licence. When it is set, the memory tool is attached only if the licence verifies at the Bouios gateway (see licenceOk).
// With no LICENCE set the memory tool is attached whenever MEMORY_URL is set, so a copy that predates licences keeps working; this is a deliberate choice.
const SETTINGS = ["MEMORY_URL", "LICENCE", "ANTHROPIC_KEY", "GATEWAY_TOKEN", "GITHUB_TOKEN"];
const UPSTREAM = "https://api.anthropic.com";
const BETA = "mcp-client-2025-11-20";
const GATEWAY = "https://memory-gateway.bouios.com";
const LICENCE_TTL_MS = 5 * 60 * 1000; // a verify answer is kept this long per isolate
const LICENCE_FAIL_TTL_MS = 30 * 1000; // a failed call (network or bad answer) is retried sooner
const licenceCache = new Map();
// Same request the Bouios memory worker makes: GET /licence/verify?licence=... with the x-licence header; the answer carries valid:true/false.
// The licence goes only to that one call, never into a message sent to the model. Any failure counts as not verified.
async function licenceOk(licence) {
  const hit = licenceCache.get(licence);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false, ttl = LICENCE_FAIL_TTL_MS;
  try {
    const r = await fetch(GATEWAY + "/licence/verify?licence=" + encodeURIComponent(licence), { headers: { "x-licence": licence } });
    if (r.ok) { const v = await r.json(); ok = !!v && v.valid === true; ttl = LICENCE_TTL_MS; }
  } catch (e) { ok = false; }
  licenceCache.set(licence, { ok, until: Date.now() + ttl });
  return ok;
}
const SYSTEM = "You are a careful assistant working for the person who set up this console. You may have Bouios memory tools and GitHub tools. When Bouios tools are available, call bouios_load first for the one project the topic implies (ask which if unclear) and show only the confirmation line it returns. Read before you change anything. Report what a tool returned. Do not claim anything is done without evidence from a tool result.";
const enc = new TextEncoder();
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function probeGithub(token) {
  const out = {};
  try {
    const r = await fetch("https://api.github.com/user", { headers: { authorization: "Bearer " + token, "user-agent": "console-gateway", accept: "application/vnd.github+json" } });
    out.github_api_user_status = r.status;
    out.github_token_scopes = r.headers.get("x-oauth-scopes") || "none listed (fine-grained or app token)";
  } catch (e) { out.github_api_user_status = "network error"; }
  try {
    const r = await fetch("https://api.githubcopilot.com/mcp/", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "console-gateway" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gw", version: "1" } } }) });
    out.github_tool_server_status = r.status;
    out.github_tool_server_reply = (await r.text()).slice(0, 140);
  } catch (e) { out.github_tool_server_status = "network error"; }
  return out;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/chat")) {
      return new Response(PAGE, { headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      }});
    }
    if (!env.GATEWAY_TOKEN || !env.ANTHROPIC_KEY) {
      return new Response("gateway not configured", { status: 503 });
    }
    if (!url.pathname.startsWith("/v1/")) {
      return new Response("not found", { status: 404 });
    }
    const presented = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      request.headers.get("x-api-key") || "";
    if (!presented || !(await safeEqual(presented, env.GATEWAY_TOKEN))) {
      return new Response("unauthorised", { status: 401 });
    }
    const wantTools = request.headers.get("x-gw-tools") === "1";
    const headers = new Headers(request.headers);
    for (const k of [...headers.keys()]) {
      if (k === "authorization" || k === "x-api-key" || k === "host" || k === "x-gw-tools" || k === "x-gw-github" || k === "content-length" || k === "origin" || k === "referer" || k === "cookie" || k.startsWith("sec-") || k.startsWith("cf-") || k.startsWith("x-forwarded-")) headers.delete(k);
    }
    headers.set("x-api-key", env.ANTHROPIC_KEY);
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    let memoryUrl = env.MEMORY_URL; // m:console-own-memory
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const toolsRequest = hasBody && wantTools && request.method === "POST" && url.pathname === "/v1/messages";
    let licenceNote = "";
    if (toolsRequest && memoryUrl && env.LICENCE && !(await licenceOk(env.LICENCE))) { // m:console-licence-gate
      memoryUrl = "";
      licenceNote = "\n\nNOTE: the memory tool is off for this message because the licence did not verify. Tell the user plainly.";
    }
    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    if (!(toolsRequest && (env.GITHUB_TOKEN || memoryUrl || licenceNote))) {
      return fetch(upstreamUrl, { method: request.method, headers, body: hasBody ? request.body : undefined });
    }
    const text = await request.text();
    let j;
    try { j = JSON.parse(text); } catch (e) {
      return fetch(upstreamUrl, { method: request.method, headers, body: text });
    }
    const all = [];
    if (memoryUrl) all.push({ name: "bouios", url: memoryUrl });
    if (env.GITHUB_TOKEN) all.push({ name: "github", url: "https://api.githubcopilot.com/mcp/", token: env.GITHUB_TOKEN });
    const dropped = [];
    const baseSystem = j.system || SYSTEM;
    const prev = headers.get("anthropic-beta");
    headers.set("anthropic-beta", prev ? prev + "," + BETA : BETA);
    for (let attempt = 0; attempt < 3; attempt++) {
      console.log("tools_attempt", attempt, all.map((s) => s.name).join(","));
      const live = all.filter((s) => !dropped.some((d) => d.name === s.name));
      const body = Object.assign({}, j, {
        mcp_servers: [...(j.mcp_servers || []), ...live.map((s) => ({ type: "url", url: s.url, name: s.name, ...(s.token ? { authorization_token: s.token } : {}) }))],
        tools: [...(j.tools || []), ...live.map((s) => ({ type: "mcp_toolset", mcp_server_name: s.name }))],
        system: baseSystem + licenceNote + dropped.map((d) => "\n\nNOTE: the tool server " + d.name + " failed to connect for this message and was left out. Tell the user plainly. Diagnostics: " + JSON.stringify(d.diag)).join(""),
      });
      if (!body.mcp_servers.length) { delete body.mcp_servers; delete body.tools; }
      const h = new Headers(headers);
      h.delete("content-length");
      h.delete("transfer-encoding");
      h.delete("content-encoding");
      const resp = await fetch(upstreamUrl, { method: "POST", headers: h, body: JSON.stringify(body) });
      if (resp.status !== 400) return resp;
      const errText = await resp.text();
      const m = errText.match(/mcp_servers\[\d+\] '([^']+)'/);
      if (!m || dropped.some((d) => d.name === m[1]) || attempt === 2) {
        return new Response(errText, { status: 400, headers: { "content-type": "application/json" } });
      }
      const diag = m[1] === "github" && env.GITHUB_TOKEN ? await probeGithub(env.GITHUB_TOKEN) : { anthropic_error: errText.split(env.MEMORY_URL || "\u0000").join("[memory url]").slice(0, 200) }; // m:console-redact-memory-url
      dropped.push({ name: m[1], diag });
      console.log("dropped_server", m[1], JSON.stringify(diag));
    }
  },
};
