# pratulsaini.fyi

Personal resume and portfolio site for Pratul Saini. Plain static HTML and CSS with no build step.

## Files

- `public/index.html`: page content
- `public/styles.css`: styles
- `wrangler.toml`: Cloudflare Pages config (project name and output folder)

## Deploying with Wrangler

From the repo root:

```sh
npx wrangler login          # first time only, opens a browser
npx wrangler pages deploy   # reads wrangler.toml and uploads ./public
```

On the first run, Wrangler offers to create the `pratulsaini-fyi` Pages project. Say yes and choose `main` as the production branch.

Then attach the domain once: Cloudflare dashboard → Workers & Pages → `pratulsaini-fyi` → **Custom domains** → add `pratulsaini.fyi`. DNS is set up automatically because the domain is on Cloudflare.

To update the site later, edit the files in `public/` and run `npx wrangler pages deploy` again.

## Local preview

```sh
cd public && python3 -m http.server
```

Then open http://localhost:8000.
