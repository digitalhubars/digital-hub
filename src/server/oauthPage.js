import 'server-only';

// Small HTML pages shown inside the sign-in popup.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON that is safe inside <script>.
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

function page(title, body, script = '') {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Digital Hub</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;color:#111827}
  @media (prefers-color-scheme:dark){body{background:#030712;color:#f3f4f6}.card{background:#111827;border-color:#1f2937}}
  .card{max-width:360px;margin:16px;padding:24px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;text-align:center}
  .spin{width:28px;height:28px;margin:0 auto 12px;border:3px solid #99f6e4;border-top-color:#0f766e;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  a{color:#0f766e}
</style></head><body><div class="card">${body}</div>${script ? `<script>${script}</script>` : ''}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}

/** First thing the popup shows while the app asks the server for the sign-in address. */
export const connectingPage = (platform) => page(`Connecting ${platform}`, `<div class="spin"></div><p>Opening ${esc(platform)} sign-in…</p>`);

/**
 * The callback's answer. Tells the Integrations page how it went (postMessage to the opener,
 * plus a same-origin BroadcastChannel because some sign-in pages cut the opener link), then
 * closes. If neither reaches the page, it sends the window back to Integrations instead.
 */
export function resultPage({ origin, platform, status, message, storeId }) {
  const data = { type: 'oauth-complete', platform, status, message: message || '', storeId: storeId || null };
  const back = `${origin}/admin/integrations?${new URLSearchParams(status === 'connected' ? { connected: storeId || '' } : { authError: message || 'Sign-in didn’t finish.' })}`;
  const ok = status === 'connected';
  return page(
    ok ? `${platform} connected` : `${platform} not connected`,
    `<p style="font-size:28px;margin:0 0 8px">${ok ? '✓' : '!'}</p><p><strong>${esc(ok ? `${platform} is connected.` : `${platform} isn’t connected.`)}</strong></p>
<p>${esc(ok ? 'You can close this window.' : message)}</p><p><a href="${esc(back)}">Back to Digital Hub</a></p>`,
    `(function(){var d=${json(data)},origin=${json(origin)},told=false;
try{if(window.opener&&!window.opener.closed){window.opener.postMessage(d,origin);told=true;}}catch(e){}
try{var c=new BroadcastChannel('digital-hub-oauth');c.postMessage(d);c.close();told=true;}catch(e){}
try{localStorage.setItem('digital-hub:oauth',JSON.stringify(Object.assign({at:Date.now()},d)));}catch(e){}
setTimeout(function(){window.close();if(!window.closed&&!told){location.replace(${json(back)});}},${ok ? 400 : 2500});})();`,
  );
}
