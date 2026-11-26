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
        return await listening(env, ctx);
      } catch (err) {
        console.error('listening error', err && err.message);
        return json({ configured: true, error: true }, 'no-store');
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function listening(env, ctx) {
  if (!env.LASTFM_API_KEY || !env.LASTFM_USER) return json({ configured: false }, 'public, max-age=60');

  const [recentData, topTracks, topArtists] = await Promise.all([
    cached(ctx, 'recent', TTL.recent, () => recentTracks(env)),
    cached(ctx, 'top-tracks', TTL.topTracks, () => topTrackList(env)),
    cached(ctx, 'top-artists', TTL.topArtists, () => topArtistList(env)),
  ]);

  return json({ configured: true, fetchedAt: Date.now(), ...recentData, topTracks, topArtists }, 'public, max-age=15');
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
  const res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': 'pratulsaini.fyi' } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) throw new Error(`last.fm ${method} failed: ${data?.message || res.status}`);
  return data;
}

// ---------- Helpers ----------

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
