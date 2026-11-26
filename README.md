# pratulsaini.fyi

Personal resume and portfolio site for Pratul Saini, with a live Spotify "now playing" player and listening stats.

## Files

- `public/index.html`, `public/styles.css`: the site
- `src/index.js`: Cloudflare Worker. Serves `public/` and adds `/api/spotify`, which returns what I'm playing, recently played, and top tracks and artists.
- `wrangler.toml`: Cloudflare config (custom domains, static files, Worker entry point)

## Deploy

```sh
npx wrangler deploy
```

## Connect Spotify (one time)

Spotify's developer rules (Feb 2026) require a **Spotify Premium** account for this.

1. Go to https://developer.spotify.com/dashboard → **Create app**.
   - Redirect URI: `https://pratulsaini.fyi/api/spotify/callback`
   - API: **Web API**
   - Copy the **Client ID** and **Client secret** from the app's settings.
2. Save them as Worker secrets (paste each value when asked):
   ```sh
   npx wrangler secret put SPOTIFY_CLIENT_ID
   npx wrangler secret put SPOTIFY_CLIENT_SECRET
   ```
3. Deploy, then open https://pratulsaini.fyi/api/spotify/login and approve access. The page that appears shows a refresh token.
4. Save that token:
   ```sh
   npx wrangler secret put SPOTIFY_REFRESH_TOKEN
   ```

The setup pages turn themselves off once the refresh token is saved. Until Spotify is connected, the player shows "Not listening right now" and the Listening section stays hidden.

To check it's working, open https://pratulsaini.fyi/api/spotify. You should see JSON with `"configured": true`.

## Local preview

```sh
cd public && python3 -m http.server
```

The Spotify player won't load data in this preview, because `/api/spotify` only exists on the deployed Worker.
