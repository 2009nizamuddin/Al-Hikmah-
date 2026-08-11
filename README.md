# Al Hikmah Live — Website (3-source live connect: al-hikmah.net → sm40 → Facebook)

This site checks **three sources**, server-side, every time someone loads
the page (and every 60s after):

1. **al-hikmah.net** direct audio stream
2. **sm40** direct audio stream
3. **Facebook Page Live** (facebook.com/alhikmah.net)

**Selection logic:**
- If al-hikmah.net and/or sm40 are live, it picks whichever has the
  **higher bitrate** (better sound quality) using the `icy-br` header
  Icecast/Shoutcast servers send.
- Only if **neither** audio source is live does it fall back to Facebook
  and embed the live video directly on the page.
- If nothing is live anywhere, it shows "Offline."

This requires a small serverless function (`netlify/functions/live-status.js`)
because Facebook's API can't safely be called from the browser (the access
token would be exposed), and because a real server-side check gets much
more reliable results than a browser can (real HTTP status codes and
headers, not just "did the connection open").

**⚠️ This means GitHub Pages won't work for this version** — GitHub Pages
only serves static files, it can't run the function. Deploy via **Netlify**
instead (still 100% free, and you can still keep your code on GitHub —
see step 2 below).

---

## 1. Get a Facebook Page Access Token (needed for the Facebook fallback)

You only need to do this once. All from your phone browser:

1. Go to **developers.facebook.com** → log in with the Facebook account
   that manages the Al Hikmah page → **My Apps → Create App** → choose
   "Other" → "Business" type → give it any name (e.g. "AlHikmahLiveCheck").
2. Go to **developers.facebook.com/tools/explorer** (Graph API Explorer).
3. In the top-right dropdowns: pick the app you just created, and under
   "User or Page", switch to the **Al Hikmah Page**.
4. Click **Generate Access Token**, and when the permissions prompt
   appears, make sure **`pages_read_engagement`** and **`pages_show_list`**
   are checked.
5. Copy the generated token — this is a *short-lived* token (a few hours).
   For a permanent one: go to **Access Token Debugger**
   (developers.facebook.com/tools/debug/accesstoken), paste your token,
   click **Extend Access Token** to get a long-lived (~60 day) one, then
   repeat periodically, OR look into converting it to a **never-expiring
   Page Access Token** (search "Facebook never-expire page access token"
   — the short version: exchange it once more using your App ID + App
   Secret via the Graph API `oauth/access_token` endpoint).
6. You also need your **Page ID**: on the Al Hikmah Facebook Page, tap
   **About** → scroll to **Page ID** (or use the Graph API Explorer,
   query `me?fields=id` while acting as the Page).

Keep the **Page ID** and **Page Access Token** handy for step 3.

## 2. Deploy to Netlify, connected to your GitHub repo

1. Push this project's files (`index.html`, `netlify.toml`,
   `netlify/functions/live-status.js`) to your existing GitHub repo — via
   the GitHub web editor / "Add file → Upload files", same as before.
2. Go to **app.netlify.com** on your phone → log in (or sign up free) →
   **Add new site → Import an existing project → Deploy with GitHub**.
3. Authorize Netlify to access GitHub, pick your website repo.
4. Build settings: leave **Build command** empty and **Publish directory**
   as `.` (Netlify will read the rest from `netlify.toml` automatically,
   including where the function lives).
5. Deploy. Netlify gives you a live URL — this one now actually runs the
   server-side check.

## 3. Add your Facebook credentials as environment variables

1. In your new Netlify site, go to **Site configuration → Environment
   variables → Add a variable**.
2. Add:
   - `FB_PAGE_ID` = the Page ID from step 1
   - `FB_PAGE_ACCESS_TOKEN` = the token from step 1
3. (Optional) also override the audio URLs if needed:
   - `ALHIKMAH_STREAM_URL` (defaults to `https://live.al-hikmah.net/;`)
   - `SM40_STREAM_URL` (defaults to a guessed sm40 mount — replace with
     the real one if you find it's different; see the DevTools method
     described earlier in this project's history)
4. **Redeploy** the site (Deploys tab → Trigger deploy) so the function
   picks up the new variables.

Without `FB_PAGE_ID`/`FB_PAGE_ACCESS_TOKEN` set, the Facebook check is
simply skipped (function still works fine for the two audio sources).

## 4. Test it

- Load the site while nothing is broadcasting anywhere → should show
  "Offline."
- During a known al-hikmah.net/sm40 broadcast → should show "Live" with
  "Connected: al-hikmah.net · [bitrate] kbps" (or sm40) under the status,
  and the audio player should play that stream.
- During a Facebook-only broadcast (check their Page to catch one) →
  should show "Live" with "Connected: Facebook Live" and the embedded
  Facebook video player should appear and autoplay.

## Notes / honest caveats

- If al-hikmah.net or sm40's server stays "reachable" even when idle
  (rather than refusing the connection), the content-type check in
  `live-status.js` is the main defense against false positives — but it's
  not bulletproof. Watch real behavior during a confirmed-offline period
  and tell me if it needs tightening.
- Facebook's long-lived tokens still expire eventually (~60 days) unless
  you do the full token-exchange-to-never-expire flow. If the Facebook
  fallback silently stops working after a couple months, that's almost
  certainly why — regenerate the token via the same Graph API Explorer
  steps.
- The Facebook embed uses Facebook's own Page Plugin (`fb-video`), so its
  playback controls, quality, and ads (if any) are entirely Facebook's,
  not something this site controls.
