# pratulsaini.fyi

Personal resume and portfolio site for Pratul Saini, with a live "now playing" player and listening stats from Spotify.

## Files

- `public/index.html`, `public/styles.css`: the site
- `src/index.js`: Cloudflare Worker. Serves `public/` and adds `/api/spotify`, which returns what I'm playing, recently played, and top tracks and artists from Spotify.
- `wrangler.toml`: Cloudflare config (custom domains, static files, Worker entry point)

## Deploy

```sh
npx wrangler deploy
```

## Connect Spotify (one time)

Spotify's developer rules (Feb 2026) require the app owner to have **Spotify Premium**. If Premium lapses, the music section stops until you resubscribe.

1. Go to https://developer.spotify.com/dashboard → **Create app**.
   - Redirect URI: `https://pratulsaini.fyi/api/spotify/callback` (click **Add**)
   - API: check **Web API**
   - Copy the **Client ID** and **Client secret** from the app's settings.
2. Save them as Worker secrets (paste each value when asked), then deploy:
   ```sh
   npx wrangler secret put SPOTIFY_CLIENT_ID
   npx wrangler secret put SPOTIFY_CLIENT_SECRET
   npx wrangler deploy
   ```
3. Open https://pratulsaini.fyi/api/spotify/login and approve. The page shows a refresh token.
4. Save it:
   ```sh
   npx wrangler secret put SPOTIFY_REFRESH_TOKEN
   ```

The setup pages turn themselves off once the refresh token is saved.
To check, open https://pratulsaini.fyi/api/spotify. You should see `"configured": true`. If it shows `"error": true`, the `reason` field says why.

## Local preview

```sh
cd public && python3 -m http.server
```

The Spotify player won't load data in this preview, because `/api/spotify` only exists on the deployed Worker.
