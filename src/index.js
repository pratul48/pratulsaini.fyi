// Cloudflare Worker for pratulsaini.fyi
//
// Serves the static site from ./public and adds a small Spotify API:
//   GET  /api/spotify            -> now playing, recently played, top tracks, top artists (JSON)
//   GET  /api/spotify/search?q=  -> search Spotify songs (for "Suggest a song")
//   POST /api/spotify/suggest    -> add a song to the "Suggested Songs" playlist, body: {"id": "<track id>"}
//   GET  /api/spotify/login      -> one-time setup: sends you to Spotify to approve access
//   GET  /api/spotify/callback   -> one-time setup: shows the refresh token to save as a secret
//
// Secrets (set with `npx wrangler secret put NAME`):
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
//   SPOTIFY_PLAYLIST_ID (optional: use this playlist instead of finding/creating "Suggested Songs")
//
// The setup routes switch themselves off once SPOTIFY_REFRESH_TOKEN is set.

const SCOPES = [
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');
const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const PLAYLIST_NAME = 'Suggested Songs';
const SITE_ORIGINS = ['https://pratulsaini.fyi', 'https://www.pratulsaini.fyi'];

// How long each piece of data is cached, in seconds. Short for "now playing" so the page feels live.
const TTL = { now: 2, recent: 20, topTracks: 6 * 3600, topArtists: 6 * 3600, search: 300 };

// Suggestion limits: per visitor (IP) and per song.
const SUGGEST_LIMIT = { perVisitor: 3, windowSec: 600, sameSongSec: 86400 };

let accessToken = { value: null, expiresAt: 0 };
let playlistCache = { id: null, url: null };

export default {
  async fetch(request, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (request.method === 'GET' && p === '/api/spotify') return await listening(env, ctx);
      if (request.method === 'GET' && p === '/api/spotify/search') return await search(url, env, ctx);
      if (request.method === 'POST' && p === '/api/spotify/suggest') return await suggest(request, env, ctx);
      if (request.method === 'GET' && p === '/api/spotify/login') return login(url, env);
      if (request.method === 'GET' && p === '/api/spotify/callback') return await callback(request, url, env);
      if (p.startsWith('/api/spotify')) return json({ error: true, reason: 'not found' }, 404);
    } catch (err) {
      console.error('spotify error', err && err.message);
      return json({ configured: true, error: true, reason: String((err && err.message) || 'unknown') }, 200);
    }
    return env.ASSETS.fetch(request);
  },
};

const configured = (env) => Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_REFRESH_TOKEN);

// ---------- Public listening data ----------

async function listening(env, ctx) {
  if (!configured(env)) return json({ configured: false });

  // Only fetch a token if something isn't cached, and share one token across the requests.
  let tokenPromise;
  const token = () => (tokenPromise ||= getAccessToken(env));

  // Load each part on its own so one failure doesn't hide the rest.
  const parts = await Promise.allSettled([
    cached(ctx, 'now', TTL.now, async () => nowPlaying(await token())),
    cached(ctx, 'recent', TTL.recent, async () => recentlyPlayed(await token())),
    cached(ctx, 'top-tracks', TTL.topTracks, async () => topItems(await token(), 'tracks')),
    cached(ctx, 'top-artists', TTL.topArtists, async () => topItems(await token(), 'artists')),
  ]);
  const names = ['now', 'recent', 'topTracks', 'topArtists'];
  const errors = {};
  parts.forEach((r, i) => { if (r.status === 'rejected') errors[names[i]] = String(r.reason?.message || r.reason); });
  if (Object.keys(errors).length === parts.length) throw new Error(errors.now);
  const val = (i, fallback) => (parts[i].status === 'fulfilled' ? parts[i].value : fallback);

  return json({
    configured: true,
    fetchedAt: Date.now(),
    now: val(0, null),
    recent: val(1, []),
    topTracks: val(2, []),
    topArtists: val(3, []),
    ...(Object.keys(errors).length ? { errors } : {}),
  });
}

async function nowPlaying(token) {
  const data = await spotifyGet('/me/player/currently-playing', token);
  if (!data || !data.item || data.currently_playing_type !== 'track') return null;
  return {
    ...track(data.item),
    isPlaying: Boolean(data.is_playing),
    progressMs: data.progress_ms || 0,
    sampledAt: Date.now(), // when we asked Spotify, so the page can work out the exact position
    durationMs: data.item.duration_ms || 0,
  };
}

async function recentlyPlayed(token) {
  const data = await spotifyGet('/me/player/recently-played?limit=6', token);
  return (data?.items || []).map((i) => ({ ...track(i.track), playedAt: i.played_at }));
}

async function topItems(token, type) {
  // Try the last 4 weeks first. If Spotify has nothing yet, fall back to ~6 months, then all time.
  let items = [];
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    const data = await spotifyGet(`/me/top/${type}?limit=5&time_range=${range}`, token);
    items = data?.items || [];
    if (items.length) break;
  }
  if (type === 'tracks') return items.map(track);
  return items.map((a) => ({
    name: a.name,
    detail: (a.genres || []).slice(0, 2).join(', ') || 'Artist',
    image: pickImage(a.images),
    url: a.external_urls?.spotify || null,
  }));
}

// Keep only what the page needs.
function track(t) {
  return {
    id: t?.id || null,
    name: t?.name || '',
    artists: (t?.artists || []).map((a) => a.name).join(', '),
    album: t?.album?.name || '',
    image: pickImage(t?.album?.images),
    url: t?.external_urls?.spotify || null,
  };
}

// Spotify lists images largest first; pick one around 300px.
function pickImage(images) {
  if (!images || !images.length) return null;
  const mid = images.find((i) => i.width && i.width <= 320);
  return (mid || images[images.length - 1]).url;
}

// ---------- Suggest a song ----------

async function search(url, env, ctx) {
  if (!configured(env)) return json({ configured: false, results: [] });
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (q.length < 2) return json({ results: [] });

  const results = await cached(ctx, 'search/' + encodeURIComponent(q.toLowerCase()), TTL.search, async () => {
    const token = await getAccessToken(env);
    const data = await spotifyGet(`/search?type=track&limit=8&q=${encodeURIComponent(q)}`, token);
    return (data?.tracks?.items || []).map(track).filter((t) => t.id);
  });
  return json({ results }, 200, 'public, max-age=60');
}

async function suggest(request, env, ctx) {
  if (!configured(env)) return json({ ok: false, reason: 'Spotify is not connected yet.' }, 503);

  // Only accept suggestions sent from this site.
  const origin = request.headers.get('Origin');
  if (!origin || !SITE_ORIGINS.includes(origin)) return json({ ok: false, reason: 'Not allowed.' }, 403);

  const body = await request.json().catch(() => null);
  const id = body && typeof body.id === 'string' ? body.id.trim() : '';
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return json({ ok: false, reason: 'That doesn\u2019t look like a Spotify song.' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const visitorKey = `suggest-ip/${ip}`;
  const songKey = `suggest-song/${id}`;
  const used = (await readCounter(visitorKey)) || 0;
  if (used >= SUGGEST_LIMIT.perVisitor) {
    return json({ ok: false, reason: 'Thanks! That\u2019s the limit for now. Try again in a few minutes.' }, 429);
  }
  if (await readCounter(songKey)) {
    return json({ ok: true, duplicate: true, playlistUrl: playlistCache.url });
  }

  const token = await getAccessToken(env);
  const playlist = await getPlaylist(env, token);
  await addToPlaylist(playlist.id, id, token);

  ctx.waitUntil(writeCounter(visitorKey, used + 1, SUGGEST_LIMIT.windowSec));
  ctx.waitUntil(writeCounter(songKey, 1, SUGGEST_LIMIT.sameSongSec));
  return json({ ok: true, playlistUrl: playlist.url });
}

// Find the "Suggested Songs" playlist, or create it if it doesn't exist yet.
async function getPlaylist(env, token) {
  if (env.SPOTIFY_PLAYLIST_ID) {
    return { id: env.SPOTIFY_PLAYLIST_ID, url: `https://open.spotify.com/playlist/${env.SPOTIFY_PLAYLIST_ID}` };
  }
  if (playlistCache.id) return playlistCache;

  const me = await spotifyGet('/me', token);
  let next = '/me/playlists?limit=50';
  for (let page = 0; next && page < 10; page++) {
    const data = await spotifyGet(next.replace(API, ''), token);
    const found = (data?.items || []).find((pl) => pl && pl.name === PLAYLIST_NAME && pl.owner?.id === me.id);
    if (found) {
      playlistCache = { id: found.id, url: found.external_urls?.spotify || `https://open.spotify.com/playlist/${found.id}` };
      return playlistCache;
    }
    next = data?.next || null;
  }

  const body = JSON.stringify({ name: PLAYLIST_NAME, public: true, description: 'Songs suggested by visitors to pratulsaini.fyi' });
  let created;
  try {
    created = await spotifySend('POST', '/me/playlists', token, body);
  } catch (err) {
    created = await spotifySend('POST', `/users/${encodeURIComponent(me.id)}/playlists`, token, body);
  }
  playlistCache = { id: created.id, url: created.external_urls?.spotify || `https://open.spotify.com/playlist/${created.id}` };
  return playlistCache;
}

async function addToPlaylist(playlistId, trackId, token) {
  const body = JSON.stringify({ uris: [`spotify:track:${trackId}`] });
  try {
    await spotifySend('POST', `/playlists/${playlistId}/items`, token, body);
  } catch (err) {
    // Older name for the same endpoint.
    await spotifySend('POST', `/playlists/${playlistId}/tracks`, token, body);
  }
}

// ---------- Spotify helpers ----------

async function getAccessToken(env) {
  if (accessToken.value && Date.now() < accessToken.expiresAt) return accessToken.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.SPOTIFY_REFRESH_TOKEN }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`token refresh failed: ${res.status} ${body?.error_description || body?.error || ''}`.trim());
  }
  const data = await res.json();
  accessToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return accessToken.value;
}

async function spotifyGet(path, token) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`spotify ${path.split('?')[0]} failed: ${res.status} ${body?.error?.message || ''}`.trim());
  }
  return res.json();
}

async function spotifySend(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(`spotify ${method} ${path} failed: ${res.status} ${data?.error?.message || ''}`.trim());
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// ---------- Edge cache helpers ----------

const cacheStore = () => (typeof caches !== 'undefined' ? caches.default : null);
const cacheKey = (key) => new Request(`https://spotify-cache.internal/${key}`);

// Cache a JSON value at Cloudflare's edge for `ttl` seconds.
async function cached(ctx, key, ttl, load) {
  const cache = cacheStore();
  if (cache) {
    const hit = await cache.match(cacheKey(key));
    if (hit) return hit.json();
  }
  const value = await load();
  if (cache) {
    const res = new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(cacheKey(key), res));
  }
  return value;
}

async function readCounter(key) {
  const cache = cacheStore();
  if (!cache) return 0;
  const hit = await cache.match(cacheKey(key));
  return hit ? Number(await hit.text()) || 0 : 0;
}

async function writeCounter(key, value, ttl) {
  const cache = cacheStore();
  if (!cache) return;
  await cache.put(cacheKey(key), new Response(String(value), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
}

// ---------- One-time setup (disabled once the refresh token is saved) ----------

function login(url, env) {
  if (env.SPOTIFY_REFRESH_TOKEN || !env.SPOTIFY_CLIENT_ID) return notFound();
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: `${url.origin}/api/spotify/callback`,
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.spotify.com/authorize?${params}`,
      'Set-Cookie': `spotify_state=${state}; Path=/api/spotify; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      'Cache-Control': 'no-store',
    },
  });
}

async function callback(request, url, env) {
  if (env.SPOTIFY_REFRESH_TOKEN || !env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return notFound();
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookie = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)spotify_state=([^;]+)/);
  if (!code || !state || !cookie || cookie[1] !== state) {
    return page('Setup failed', '<p>The login link expired or did not match. Go back to <a href="/api/spotify/login">/api/spotify/login</a> and try again.</p>', 400);
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/api/spotify/callback` }),
  });
  if (!res.ok) return page('Setup failed', `<p>Spotify rejected the request (HTTP ${res.status}). Check the client ID, secret, and redirect URI.</p>`, 502);
  const data = await res.json();

  return page('Spotify connected', `
    <p>Copy this refresh token. It works like a password for your Spotify account, so don't share it.</p>
    <pre>${escapeHtml(data.refresh_token || '')}</pre>
    <p>In your terminal, inside the <code>pratulsaini.fyi</code> folder, run:</p>
    <pre>npx wrangler secret put SPOTIFY_REFRESH_TOKEN</pre>
    <p>Paste the token when it asks. Once it's saved, this setup page turns itself off.</p>`);
}

// ---------- Small utilities ----------

// Pasting into a terminal can add spaces, quotes, or line breaks. Strip them.
function cleanEnv(env) {
  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '').trim() : v);
  return {
    ...env,
    SPOTIFY_CLIENT_ID: clean(env.SPOTIFY_CLIENT_ID),
    SPOTIFY_CLIENT_SECRET: clean(env.SPOTIFY_CLIENT_SECRET),
    SPOTIFY_REFRESH_TOKEN: clean(env.SPOTIFY_REFRESH_TOKEN),
    SPOTIFY_PLAYLIST_ID: clean(env.SPOTIFY_PLAYLIST_ID),
  };
}

function json(body, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  });
}

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#1a1714}pre{white-space:pre-wrap;word-break:break-all;background:#f3efe7;padding:1rem;border-radius:8px}</style>
<h1>${escapeHtml(title)}</h1>${body}`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Set-Cookie': 'spotify_state=; Path=/api/spotify; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      },
    },
  );
}

function notFound() {
  return new Response('Not found', { status: 404 });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
