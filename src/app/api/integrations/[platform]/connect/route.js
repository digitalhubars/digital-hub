import { credentialsFrom, loadSecretsRow, peekOAuthState } from '../../../../../server/credentials';
import { connectingPage, resultPage } from '../../../../../server/oauthPage';
import { getAdapter, platformFromSlug } from '../../../../../server/platforms';
import { appOrigin, getRecord } from '../../../../../server/sync';

export const dynamic = 'force-dynamic';

// The sign-in popup's address.
// - Without ?state: the page the popup opens with straight away (so browsers don't block it).
// - With ?state (created a moment later by POST /api/integrations/authorize for a signed-in
//   admin): redirects to the platform's official sign-in / consent page. If the seller is
//   already signed in there, they only see the Authorize screen.
export async function GET(request, { params }) {
  const origin = appOrigin(request);
  const platform = platformFromSlug(params.platform);
  const adapter = platform && getAdapter(platform);
  if (!adapter) return resultPage({ origin, platform: 'This platform', status: 'error', message: 'Unknown platform.' });

  const stateParam = new URL(request.url).searchParams.get('state');
  if (!stateParam) return connectingPage(platform);

  const saved = await peekOAuthState(stateParam, platform).catch(() => null);
  if (!saved) return resultPage({ origin, platform, status: 'error', message: 'This sign-in link expired. Close the window and try again.' });

  try {
    const store = saved.store_id ? await getRecord('stores', saved.store_id) : null;
    const creds = store ? credentialsFrom(store, await loadSecretsRow(store.id)) || {} : {};
    const url = adapter.authorizeUrl({
      creds,
      state: stateParam,
      redirectUri: `${origin}/api/integrations/callback/${params.platform}`,
      codeChallenge: saved.code_challenge,
      meta: saved.meta,
      store: store || { region: saved.meta.region },
    });
    return Response.redirect(url, 302);
  } catch (err) {
    return resultPage({ origin, platform, status: 'error', message: err.message });
  }
}
