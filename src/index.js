// Cloudflare Worker for pratulsaini.fyi
//
// Serves the static site from ./public and adds a small Spotify API:
//   GET /api/spotify           -> now playing, recently played, top tracks, top artists (JSON)
//   GET /api/spotify/login     -> one-time setup: sends you to Spotify to approve access
//   GET /api/spotify/callback  -> one-time setup: shows the refresh token to save as a secret
//
// Secrets (set with `npx wrangler secret put NAME`):
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
//
// The setup routes switch themselves off once SPOTIFY_REFRESH_TOKEN is set.

const SCOPES = 'user-read-currently-playing user-read-recently-played user-top-read';
const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

// How long each piece of data is cached, in seconds. Keeps us well under Spotify's quota.
const TTL = { now: 30, recent: 120, topTracks: 6 * 3600, topArtists: 6 * 3600 };

let accessToken = { value: null, expiresAt: 0 };

export default {
  async fetch(request, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
    const url = new URL(request.url);
    if (request.method !== 'GET') return env.ASSETS.fetch(request);

    try {
      if (url.pathname === '/api/spotify') return await listening(env, ctx);
      if (url.pathname === '/api/spotify/login') return login(url, env);
      if (url.pathname === '/api/spotify/callback') return await callback(request, url, env);
    } catch (err) {
      console.error('spotify error', err && err.message);
      return json({ configured: true, error: true, reason: String((err && err.message) || 'unknown') }, 200, 'no-store');
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------- Public listening data ----------

async function listening(env, ctx) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !env.SPOTIFY_REFRESH_TOKEN) {
    return json({ configured: false }, 200, 'public, max-age=60');
  }
  // Only fetch a token if something isn't cached, and share one token across the requests.
  let tokenPromise;
  const token = () => (tokenPromise ||= getAccessToken(env));

  const [now, recent, topTracks, topArtists] = await Promise.all([
    cached(ctx, 'now', TTL.now, async () => nowPlaying(await token())),
    cached(ctx, 'recent', TTL.recent, async () => recentlyPlayed(await token())),
    cached(ctx, 'top-tracks', TTL.topTracks, async () => topItems(await token(), 'tracks')),
    cached(ctx, 'top-artists', TTL.topArtists, async () => topItems(await token(), 'artists')),
  ]);

  return json({ configured: true, fetchedAt: Date.now(), now, recent, topTracks, topArtists }, 200, 'public, max-age=15');
}

async function nowPlaying(token) {
  const data = await spotifyGet('/me/player/currently-playing', token);
  if (!data || !data.item || data.currently_playing_type !== 'track') return null;
  return {
    ...track(data.item),
    isPlaying: Boolean(data.is_playing),
    progressMs: data.progress_ms || 0,
    durationMs: data.item.duration_ms || 0,
  };
}

async function recentlyPlayed(token) {
  const data = await spotifyGet('/me/player/recently-played?limit=6', token);
  return (data?.items || []).map((i) => ({ ...track(i.track), playedAt: i.played_at }));
}

async function topItems(token, type) {
  const data = await spotifyGet(`/me/top/${type}?limit=5&time_range=short_term`, token);
  const items = data?.items || [];
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
    throw new Error(`spotify ${path} failed: ${res.status} ${body?.error?.message || ''}`.trim());
  }
  return res.json();
}

// Cache a JSON value at Cloudflare's edge for `ttl` seconds.
async function cached(ctx, key, ttl, load) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://spotify-cache.internal/${key}`);
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
    <p>Copy this refresh token. It works like a password for your Spotify listening data, so don't share it.</p>
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
