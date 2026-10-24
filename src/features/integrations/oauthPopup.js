// "Sign in with …" in a popup.
//
// 1. openOAuthPopup() runs inside the click handler, before anything async, so browsers
//    don't block the window. It shows /api/integrations/<slug>/connect ("Opening sign-in…").
// 2. The caller asks the server for the real address (POST /api/integrations/authorize) and
//    calls popup.go(url): the connect route redirects to the platform's sign-in page.
// 3. The callback page reports back with postMessage (opener) and, because some sign-in pages
//    cut the opener link, a same-origin BroadcastChannel / localStorage event too.
//    popup.result resolves with { status: 'connected' | 'error' | 'closed', message, storeId }.

const FEATURES = 'popup=yes,width=520,height=720,left=120,top=80';
const CHANNEL = 'digital-hub-oauth';

/** onLate(data): an answer that arrives after the window already looked closed. */
export function openOAuthPopup(slug, { onLate } = {}) {
  const win = window.open(`/api/integrations/${slug}/connect`, `digital-hub-oauth-${slug}`, FEATURES);
  if (!win) return null;

  let settle;
  const result = new Promise((resolve) => {
    settle = resolve;
  });
  let done = false;
  let closedAt = 0;
  let channel = null;

  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
    channel?.close();
    clearInterval(timer);
  };
  let lateUntil = 0;
  const finish = (outcome) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (outcome.status === 'closed') {
      // Keep listening for 15 minutes in case the sign-in was still going on.
      lateUntil = Date.now() + 15 * 60000;
      setTimeout(cleanup, 15 * 60000);
    } else cleanup();
    settle(outcome);
  };

  const accept = (data) => {
    if (!data || data.type !== 'oauth-complete') return;
    const outcome = { status: data.status, message: data.message, storeId: data.storeId, platform: data.platform };
    if (done) {
      if (lateUntil > Date.now()) {
        lateUntil = 0;
        cleanup();
        onLate?.(outcome);
      }
      return;
    }
    finish(outcome);
  };
  const onMessage = (event) => {
    if (event.origin !== window.location.origin) return; // only our own callback page
    accept(event.data);
  };
  const onStorage = (event) => {
    if (event.key !== 'digital-hub:oauth' || !event.newValue) return;
    try {
      accept(JSON.parse(event.newValue));
    } catch {
      // ignore
    }
  };
  window.addEventListener('message', onMessage);
  window.addEventListener('storage', onStorage);
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => accept(event.data);
  } catch {
    channel = null;
  }

  // Closed without an answer: give the callback a moment (some sign-in pages make the window
  // look closed while it's still open), then report it as closed.
  const timer = setInterval(() => {
    if (!win.closed) {
      closedAt = 0;
      return;
    }
    if (!closedAt) closedAt = Date.now();
    else if (Date.now() - closedAt > 2500) finish({ status: 'closed' });
  }, 500);

  return {
    result,
    /** Sends the popup to the server's connect address (keeps the same window). */
    go(url) {
      if (!win.closed) win.location.href = url;
    },
    /** Shows an error in the caller and closes the popup. */
    fail(message) {
      try {
        win.close();
      } catch {
        // ignore
      }
      finish({ status: 'error', message });
    },
  };
}
