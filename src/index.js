// Cloudflare Worker for pratulsaini.fyi
//
// Serves the static site from ./public and adds one API route:
//   GET /api/spotify -> now playing, recently played, top tracks, top artists (JSON)
//
// The data comes from Last.fm, which logs ("scrobbles") everything played on Spotify.
// That works on a free Spotify account, unlike Spotify's own API, which now requires Premium.
//
// Secrets (set with `npx wrangler secret put NAME`):
//   LASTFM_API_KEY  - free key from https://www.last.fm/api/account/create
//   LASTFM_USER     - your Last.fm username

const API = 'https://ws.audioscrobbler.com/2.0/';

// How long each piece of data is cached, in seconds.
const TTL = { recent: 30, topTracks: 6 * 3600, topArtists: 6 * 3600 };

// Last.fm returns this grey star image when it has no real artwork.
const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/spotify') {
      try {
        return await listening(cleanEnv(env), ctx);
      } catch (err) {
        console.error('listening error', err && err.message);
        // Last.fm's message (like "User not found") is safe to show and makes setup problems easy to spot.
        return json({ configured: true, error: true, reason: String((err && err.message) || 'unknown') }, 'no-store');
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function listening(env, ctx) {
  if (!env.LASTFM_API_KEY || !env.LASTFM_USER) return json({ configured: false }, 'public, max-age=60');

  // Load each part on its own, so one failed Last.fm call doesn't blank the whole section.
  const results = await Promise.allSettled([
    cached(ctx, 'recent', TTL.recent, () => recentTracks(env)),
    cached(ctx, 'top-tracks', TTL.topTracks, () => topTrackList(env)),
    cached(ctx, 'top-artists', TTL.topArtists, () => topArtistList(env)),
  ]);
  const [recentRes, tracksRes, artistsRes] = results;
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === results.length) throw failed[0].reason;
  failed.forEach((r) => console.error('partial listening error', r.reason && r.reason.message));

  const recentData = recentRes.status === 'fulfilled' ? recentRes.value : { now: null, recent: [] };
  return json({
    configured: true,
    fetchedAt: Date.now(),
    ...recentData,
    topTracks: tracksRes.status === 'fulfilled' ? tracksRes.value : [],
    topArtists: artistsRes.status === 'fulfilled' ? artistsRes.value : [],
    ...(failed.length ? { partial: true } : {}),
  }, failed.length ? 'no-store' : 'public, max-age=15');
}

// ---------- Last.fm calls ----------

async function recentTracks(env) {
  const data = await lastfm(env, 'user.getrecenttracks', { limit: '7' });
  const items = asArray(data?.recenttracks?.track);

  let now = null;
  const recent = [];
  for (const t of items) {
    const item = {
      name: t.name || '',
      artists: t.artist?.['#text'] || '',
      album: t.album?.['#text'] || '',
      image: pickImage(t.image),
    };
    item.url = spotifySearch(item.name, item.artists);
    if (t['@attr']?.nowplaying === 'true') {
      now = { ...item, isPlaying: true, progressMs: 0, durationMs: 0 };
    } else if (t.date?.uts) {
      recent.push({ ...item, playedAt: new Date(Number(t.date.uts) * 1000).toISOString() });
    }
  }
  return { now, recent: recent.slice(0, 6) };
}

async function topTrackList(env) {
  const data = await lastfm(env, 'user.gettoptracks', { period: '1month', limit: '5' });
  const items = asArray(data?.toptracks?.track);
  // Top-track results have no artwork, so look up each track's album cover.
  return Promise.all(items.map(async (t) => {
    const name = t.name || '';
    const artist = t.artist?.name || '';
    let image = pickImage(t.image);
    if (!image) {
      try {
        const info = await lastfm(env, 'track.getInfo', { track: name, artist, autocorrect: '1' });
        image = pickImage(info?.track?.album?.image);
      } catch { /* no artwork is fine */ }
    }
    return { name, artists: artist, image, url: spotifySearch(name, artist), plays: Number(t.playcount) || 0 };
  }));
}

async function topArtistList(env) {
  const data = await lastfm(env, 'user.gettopartists', { period: '1month', limit: '5' });
  return asArray(data?.topartists?.artist).map((a) => {
    const plays = Number(a.playcount) || 0;
    return {
      name: a.name || '',
      detail: `${plays.toLocaleString('en-US')} ${plays === 1 ? 'play' : 'plays'}`,
      image: pickImage(a.image),
      url: spotifySearch(a.name || ''),
    };
  });
}

async function lastfm(env, method, params) {
  const qs = new URLSearchParams({ method, user: env.LASTFM_USER, api_key: env.LASTFM_API_KEY, format: 'json', ...params });
  // Retry once on temporary errors. Error 8 isn't retried: Last.fm also returns it for accounts with no scrobbles yet.
  for (let attempt = 0; ; attempt++) {
    let res, data;
    try {
      // Give up on a slow Last.fm call after 4 seconds so the page never hangs.
      res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': 'pratulsaini.fyi (+https://pratulsaini.fyi)' }, signal: AbortSignal.timeout(4000) });
      data = await res.json().catch(() => null);
    } catch (err) {
      if (attempt < 1) continue;
      throw new Error(`last.fm ${method} timed out`);
    }
    if (res.ok && data && !data.error) return data;
    const temporary = !data || [11, 16, 29].includes(data.error) || res.status >= 500;
    if (temporary && attempt < 1) { await new Promise((r) => setTimeout(r, 300)); continue; }
    throw new Error(`last.fm ${method} failed: ${data?.message || res.status}`);
  }
}

// ---------- Helpers ----------

// Pasting into a terminal can add spaces, quotes, or line breaks. Strip them.
function cleanEnv(env) {
  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '').trim() : v);
  return { ...env, LASTFM_API_KEY: clean(env.LASTFM_API_KEY), LASTFM_USER: clean(env.LASTFM_USER) };
}

// Links open the song or artist in Spotify.
function spotifySearch(...parts) {
  const q = parts.filter(Boolean).join(' ').trim();
  return q ? `https://open.spotify.com/search/${encodeURIComponent(q)}` : null;
}

// Last.fm lists images small -> extralarge. Use "extralarge" (300px), skip placeholders.
function pickImage(images) {
  const list = asArray(images).filter((i) => i && i['#text'] && !i['#text'].includes(PLACEHOLDER));
  if (!list.length) return null;
  const big = list.find((i) => i.size === 'extralarge') || list[list.length - 1];
  return big['#text'].replace(/^http:/, 'https:');
}

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

// Cache a JSON value at Cloudflare's edge for `ttl` seconds.
async function cached(ctx, key, ttl, load) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://listening-cache.internal/${key}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  const value = await load();
  if (cache) {
    const res = new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(cacheKey, res));
  }
  return value;
}

function json(body, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  });
}
