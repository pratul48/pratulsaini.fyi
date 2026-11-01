# pratulsaini.fyi

Personal resume and portfolio site for Pratul Saini. Plain static HTML and CSS with no build step.

## Files

- `index.html`: page content
- `styles.css`: styles

## Deploying on Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick this repo.
2. Build settings: Framework preset **None**, build command empty, build output directory `/`.
3. After the first deploy: project → **Custom domains** → add `pratulsaini.fyi` (and `www.pratulsaini.fyi` if wanted). Cloudflare creates the DNS records automatically since the domain is already on Cloudflare.

Every push to `main` redeploys the site.

## Editing

Change the text in `index.html` and push. To preview locally, run `python3 -m http.server` in this folder and open http://localhost:8000.
