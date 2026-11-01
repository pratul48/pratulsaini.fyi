# pratulsaini.fyi

Personal resume and portfolio site for Pratul Saini. Plain static HTML and CSS with no build step.

## Files

- `public/index.html`: page content
- `public/styles.css`: styles
- `wrangler.toml`: Cloudflare Workers config. It serves `./public` as static assets on `pratulsaini.fyi` and `www.pratulsaini.fyi`. The `*.workers.dev` URL and preview URLs are turned off.

## Deploying with Wrangler

From the repo root:

```sh
npx wrangler login    # first time only, opens a browser
npx wrangler deploy   # uploads ./public and attaches the custom domains
```

Wrangler creates the DNS records and SSL certificate for both domains. If the deploy fails because a DNS record already exists for `pratulsaini.fyi` or `www`, delete that record in Cloudflare → your domain → DNS → Records, then deploy again.

To update the site later, edit the files in `public/` and run `npx wrangler deploy` again.

## Local preview

```sh
cd public && python3 -m http.server
```

Then open http://localhost:8000.
