/**
 * Netlify Function: /api/live-status  (mapped via netlify.toml redirect)
 *
 * Checks whether al-hikmah.net's audio stream is genuinely live right now.
 *
 * "Reachable but not really live" problem: Icecast mounts are often
 * configured with a fallback file that plays on a loop whenever the real
 * broadcaster (source client) has disconnected. That fallback audio still
 * answers with an audio content-type, so a plain reachability check would
 * report "live" even when nothing current is being broadcast. To tell
 * these apart we also check for the "icy-metaint" response header: this is
 * only sent by Icecast/Shoutcast when the currently playing content is
 * being relayed live from a connected source client (which sends in-band
 * title metadata). Content served directly by the server itself as a
 * fallback file normally does NOT include this header. So the source only
 * counts as truly "live" here if it looks like audio AND advertises
 * icy-metaint.
 *
 * Facebook: there's no Page Access Token configured (that requires a
 * Facebook account that administers the page), so Facebook Live can't be
 * checked automatically. Instead we just pass along a plain link to the
 * Facebook Page (FB_PAGE_URL) so the site can offer a manual "check
 * Facebook" button.
 */

const AL_HIKMAH_URL = process.env.ALHIKMAH_STREAM_URL || "https://live.al-hikmah.net/;";
const PROBE_TIMEOUT_MS = 5000;

async function probeAudioStream(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Icy-MetaData": "1", "User-Agent": "AlHikmahLiveStatusCheck/1.0" },
      signal: controller.signal
    });

    // We only need headers, not the audio body — cancel it right away
    // so the function doesn't hang open on a live stream.
    if (res.body && typeof res.body.cancel === "function") {
      res.body.cancel().catch(() => {});
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const looksLikeAudio =
      contentType.includes("audio") ||
      contentType.includes("mpeg") ||
      contentType.includes("aac") ||
      contentType.includes("ogg");

    // icy-metaint is only present when a real source client (broadcaster)
    // is actively connected and relaying in-band title metadata. A
    // server-side fallback/looped file normally won't set this header.
    const hasSourceConnected = res.headers.get("icy-metaint") !== null;

    const reachable = res.ok && looksLikeAudio;
    const isLive = reachable && hasSourceConnected;
    const bitrateHeader = res.headers.get("icy-br"); // e.g. "128"
    const bitrate = bitrateHeader ? parseInt(bitrateHeader, 10) : null;

    return { live: isLive, reachable, hasSourceConnected, bitrate, url };
  } catch (e) {
    return { live: false, reachable: false, hasSourceConnected: false, bitrate: null, url };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function () {
  const alHikmah = await probeAudioStream(AL_HIKMAH_URL);

  const sourceUrls = { alhikmah: AL_HIKMAH_URL };
  const facebookPageUrl = process.env.FB_PAGE_URL || null;

  if (alHikmah.live) {
    return respond({
      live: true,
      source: "alhikmah",
      type: "audio",
      streamUrl: alHikmah.url,
      bitrateKbps: alHikmah.bitrate,
      sourceUrls,
      facebookPageUrl,
      allSourcesChecked: {
        alhikmah: { live: true, reachable: alHikmah.reachable, sourceConnected: alHikmah.hasSourceConnected, bitrateKbps: alHikmah.bitrate }
      }
    });
  }

  return respond({
    live: false,
    source: null,
    sourceUrls,
    facebookPageUrl,
    allSourcesChecked: {
      alhikmah: { live: false, reachable: alHikmah.reachable, sourceConnected: alHikmah.hasSourceConnected, bitrateKbps: alHikmah.bitrate }
    }
  });
};

function respond(body) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

