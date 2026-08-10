# Al Hikmah Live — Website

A single-file static website (`index.html` — HTML/CSS/JS, no build step, no
framework) that mirrors the Al Hikmah / Rajarbag Shareef live audio broadcast:
live/offline status badge, a play/pause + volume audio player, a fallback
embed of the original site, and a "notify me" signup form (UI only for now).

## Two things to fill in later

Open `index.html`, near the bottom in the `<script>` section:

```js
const STREAM_URL = "https://stream.sm40.com/;stream.mp3"; // real direct audio stream URL
const STATUS_CHECK_URL = null; // e.g. an Icecast status-json.xsl endpoint
```

Until `STATUS_CHECK_URL` is set, the live/offline badge uses a mock check
(always settles to "Offline" after a moment) so the UI is fully visible
and testable. See the earlier conversation for how to find the real
stream URL and status endpoint using Chrome DevTools' Network tab.

## Deploy it — entirely from your phone, no PC needed

**Easiest option: Netlify Drop**
1. On your phone, go to **https://app.netlify.com/drop** in your browser.
2. Log in / sign up (free).
3. Tap to browse files, select `index.html` (and this whole folder if your
   file picker supports folder upload) and drop/upload it.
4. Netlify gives you a live URL immediately (like `random-name-123.netlify.app`).
   That's your website — done.
5. Anytime you want to update it, edit `index.html` and re-upload the same
   way, or connect Netlify to a GitHub repo for automatic redeploys on push.

**Alternative: GitHub Pages** (if you'd rather use the GitHub repo you may
have already started for the app project)
1. In your GitHub repo, create a new file at the root named `index.html`
   and paste this file's contents in via the GitHub web editor (pencil
   icon), or upload it with **Add file → Upload files**.
2. Go to **Settings → Pages** in the repo → under "Build and deployment",
   set Source to **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Save. GitHub gives you a URL like `https://<username>.github.io/<repo>/`
   within a minute or two.

Both options are free and require nothing beyond a mobile browser.

## Notes

- The audio element only starts loading the stream when Play is tapped
  (`preload="none"`), which is friendlier to mobile data and avoids
  autoplay restrictions in browsers.
- The fallback iframe (`live.al-hikmah.net`) only loads when the visitor
  taps to open it, so it doesn't slow down the initial page load.
- The "Notify me" form currently only shows a success message locally —
  it isn't wired to send real emails yet. That needs a backend or a
  service like Mailchimp/ConvertKit/Formspree once you're ready for it.
  
