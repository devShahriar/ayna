import { openPersistentContext } from './browser.mjs';

/**
 * Hand the user a window and wait for them to get through the sign-in.
 *
 * Claude must not type someone's credentials — not into their app, not from a
 * flow file, not "just this once". But a review that dies at a login screen is
 * no use either, so the honest arrangement is: the tool opens the door, the
 * person walks through it, and the session is remembered so it is asked once
 * rather than every time.
 *
 * Nothing typed here is captured. This watches only whether the page still looks
 * like a sign-in.
 */
export async function waitForLogin({ profileDir, url, viewport, timeoutMs = 5 * 60 * 1000, onState }) {
  const context = await openPersistentContext({ profileDir, headless: false, viewport });
  const page = context.pages()[0] ?? (await context.newPage());

  const looksLikeSignIn = () =>
    page
      .evaluate(() => {
        const byField = !!document.querySelector('input[type=password]');
        const byPath = /(^|\/)(sign-?in|log-?in|auth|sso|oauth)(\/|$)/i.test(location.pathname);
        return { signIn: byField || byPath, url: location.href };
      })
      .catch(() => null);

  try {
    let requestedIsLogin = false;
    try {
      requestedIsLogin = /(^|\/)(sign-?in|log-?in|auth|sso|oauth)(\/|$)/i.test(new URL(url).pathname);
    } catch {}

    const initialCookies = await context.cookies().catch(() => []);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const first = await looksLikeSignIn();
    if (requestedIsLogin && first && !first.signIn) {
      // Requested an explicit login route, but redirected away because of a valid session
      onState?.({ state: 'already-signed-in', url: first.url });
      return { signedIn: true, alreadySignedIn: true, url: first.url };
    }

    onState?.({ state: 'waiting', url: first?.url ?? url });

    let sawSignIn = first?.signIn ?? false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        const cookies = await context.cookies().catch(() => []);
        if (sawSignIn && cookies.length > initialCookies.length) {
          return { signedIn: true, url: page.url?.() };
        }
        return { signedIn: false, closed: true };
      }
      const now = await looksLikeSignIn();
      if (now?.signIn) {
        sawSignIn = true;
      }
      if (sawSignIn && now && !now.signIn) {
        await page.waitForTimeout(1500); // let a redirect settle before believing it
        const settled = await looksLikeSignIn();
        if (settled && !settled.signIn) {
          onState?.({ state: 'signed-in', url: settled.url });
          return { signedIn: true, url: settled.url };
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    return { signedIn: false, timedOut: true };
  } finally {
    await context.close().catch(() => {});
  }
}
