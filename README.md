# pratulsaini.fyi

Personal resume and portfolio site for Pratul Saini, with a live "now playing" player and listening stats from Spotify (through Last.fm).

## Files

- `public/index.html`, `public/styles.css`: the site
- `src/index.js`: Cloudflare Worker. Serves `public/` and adds `/api/spotify`, which returns what I'm playing, recently played, and top tracks and artists from Last.fm.
- `wrangler.toml`: Cloudflare config (custom domains, static files, Worker entry point)

## Deploy

```sh
npx wrangler deploy
```

## Connect your listening (one time)

The music data comes from **Last.fm**, which logs everything you play on Spotify. It works with a free Spotify account. Spotify's own API now requires Premium.

1. Make a free account at https://www.last.fm/join.
2. Connect Spotify: https://www.last.fm/settings/applications → **Spotify scrobbling** → **Connect**. From now on, every song you play on Spotify is logged.
3. Get an API key at https://www.last.fm/api/account/create. Fill in any app name, leave the callback URL blank, and copy the **API key**. You don't need the shared secret.
4. Save your key and username as Worker secrets, pasting each when asked:
   ```sh
   npx wrangler secret put LASTFM_API_KEY
   npx wrangler secret put LASTFM_USER
   ```

To check it's working, open https://pratulsaini.fyi/api/spotify. You should see JSON with `"configured": true` and your songs. Until it's set up, the player shows "Not listening right now" and the Listening section stays hidden.

Last.fm only knows what you've played since you connected it, so the top tracks and artists fill in over the first week or two.

## Local preview

```sh
cd public && python3 -m http.server
```

The Spotify player won't load data in this preview, because `/api/spotify` only exists on the deployed Worker.
