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

    if (res.body && typeof res.body.cancel === "function") {
      res.body.cancel().catch(() => {});
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const looksLikeAudio =
      contentType.includes("audio") ||
      contentType.includes("mpeg") ||
      contentType.includes("aac") ||
      contentType.includes("ogg");

    const isLive = res.ok && looksLikeAudio;
    const bitrateHeader = res.headers.get("icy-br");
    const bitrate = bitrateHeader ? parseInt(bitrateHeader, 10) : null;

    return { live: isLive, bitrate, url };
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
    liveAudioSources.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const best = liveAudioSources[0];

    return respond({
      live: true,
      source: best.name,
      type: "audio",
      streamUrl: best.url,
      bitrateKbps: best.bitrate,
      allSourcesChecked: {
        alhikmah: { live: alHikmah.live, bitrateKbps: alHikmah.bitrate },
        sm40: { live: sm40.live, bitrateKbps: sm40.bitrate }
      }
    });
  }

  const facebook = await probeFacebookLive();
  if (facebook.live) {
    return respond({
      live: true,
      source: "facebook",
      type: "video",
      embedUrl: facebook.permalink,
      allSourcesChecked: {
        alhikmah: { live: false },
        sm40: { live: false },
        facebook: { live: true }
      }
    });
  }

  return respond({
    live: false,
    source: null,
    facebookConfigured: facebook.configured,
    allSourcesChecked: {
      alhikmah: { live: false },
      sm40: { live: false },
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
