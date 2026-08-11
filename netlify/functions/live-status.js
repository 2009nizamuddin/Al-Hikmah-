/**
 * Netlify Function: /api/live-status  (mapped via netlify.toml redirect)
 *
 * Strategy:
 * 1. Probe both audio sources (al-hikmah.net direct stream, sm40 direct
 *    stream) in parallel. For each one that's live, read its Icecast/
 *    Shoutcast "icy-br" header (bitrate in kbps) if the server sends it.
 * 2. If one or both audio sources are live, pick the one with the HIGHER
 *    bitrate (best sound quality). If only one is live, use that one.
 * 3. Only if NEITHER audio source is live, fall back to checking the
 *    Facebook Page for an active live video.
 *
 * Why Facebook isn't compared by "quality" too: Facebook Live is a
 * different kind of stream (adaptive video, not a fixed Icecast mount),
 * and the Graph API doesn't expose a bitrate figure that's meaningfully
 * comparable to an audio icy-br value. So it's treated as a fallback,
 * not a third option ranked by quality.
 *
 * "Reachable but not really live" problem: Icecast mounts are often
 * configured with a fallback file that plays on a loop whenever the real
 * broadcaster (source client) has disconnected. That fallback audio still
 * answers with an audio content-type and can even carry an icy-br value,
 * so a plain reachability check reports "live" even when nothing current
 * is being broadcast. To tell these apart we also check for the
 * "icy-metaint" response header: this is only sent by Icecast/Shoutcast
 * when the currently playing content is being relayed live from a
 * connected source client (which sends in-band title metadata). Content
 * served directly by the server itself as a fallback file normally does
 * NOT include this header. So a source only counts as truly "live" here
 * if it looks like audio AND advertises icy-metaint.
 */

const AL_HIKMAH_URL = process.env.ALHIKMAH_STREAM_URL || "https://live.al-hikmah.net/;";
const SM40_URL = process.env.SM40_STREAM_URL || "https://stream.sm40.com/;stream.mp3";
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
    return { live: false, bitrate: null, url };
  } finally {
    clearTimeout(timer);
  }
}

async function probeFacebookLive() {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) return { live: false, configured: false };

  try {
    const graphUrl =
      `https://graph.facebook.com/v19.0/${pageId}/live_videos` +
      `?broadcast_status=["LIVE"]&fields=id,status,permalink_url&access_token=${token}`;
    const res = await fetch(graphUrl);
    const data = await res.json();

    if (data && Array.isArray(data.data) && data.data.length > 0) {
      const liveVideo = data.data.find(v => v.status === "LIVE") || data.data[0];
      return {
        live: true,
        configured: true,
        permalink: liveVideo.permalink_url,
        videoId: liveVideo.id
      };
    }
    return { live: false, configured: true };
  } catch (e) {
    return { live: false, configured: true, error: true };
  }
}

exports.handler = async function () {
  const [alHikmah, sm40] = await Promise.all([
    probeAudioStream(AL_HIKMAH_URL),
    probeAudioStream(SM40_URL)
  ]);

  const liveAudioSources = [
    { name: "alhikmah", ...alHikmah },
    { name: "sm40", ...sm40 }
  ].filter(s => s.live);

  if (liveAudioSources.length > 0) {
    // Prefer higher bitrate. If bitrate is unknown for a source, treat it
    // as 0 for comparison so a source WITH a known bitrate wins ties.
    liveAudioSources.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const best = liveAudioSources[0];

    return respond({
      live: true,
      source: best.name,
      type: "audio",
      streamUrl: best.url,
      bitrateKbps: best.bitrate,
      allSourcesChecked: {
        alhikmah: { live: alHikmah.live, reachable: alHikmah.reachable, sourceConnected: alHikmah.hasSourceConnected, bitrateKbps: alHikmah.bitrate },
        sm40: { live: sm40.live, reachable: sm40.reachable, sourceConnected: sm40.hasSourceConnected, bitrateKbps: sm40.bitrate }
      }
    });
  }

  // Neither audio source is live — fall back to Facebook.
  const facebook = await probeFacebookLive();
  if (facebook.live) {
    return respond({
      live: true,
      source: "facebook",
      type: "video",
      embedUrl: facebook.permalink,
      allSourcesChecked: {
        alhikmah: { live: false, reachable: alHikmah.reachable, sourceConnected: alHikmah.hasSourceConnected },
        sm40: { live: false, reachable: sm40.reachable, sourceConnected: sm40.hasSourceConnected },
        facebook: { live: true }
      }
    });
  }

  return respond({
    live: false,
    source: null,
    facebookConfigured: facebook.configured,
    allSourcesChecked: {
      alhikmah: { live: false, reachable: alHikmah.reachable, sourceConnected: alHikmah.hasSourceConnected },
      sm40: { live: false, reachable: sm40.reachable, sourceConnected: sm40.hasSourceConnected },
      facebook: { live: false, configured: facebook.configured }
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

