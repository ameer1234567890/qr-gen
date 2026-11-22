# qr-gen

A small QR code generator that runs on **Cloudflare Workers**.

- Enter a URL, get a **PNG with a transparent background** (black modules).
- Dark mode switch (remembers your choice, follows the OS by default).
- No login, no database, no secrets: the Worker is fully stateless.
- No runtime dependencies: the QR encoder and PNG writer are included in `src/`.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ameer1234567890/qr-gen)

Clicking the button connects your GitHub/GitLab account, copies the repo into it, builds it and deploys it.
There is nothing to configure. Your app is then live at `https://qr-gen.<your-subdomain>.workers.dev`,
and later pushes to the repo redeploy it.

> **This app is public.** Anyone with the URL can generate QR codes. Nothing is stored or logged by the app.
> To limit abuse, add a Cloudflare rate-limiting rule on `/api/generate`
> (*Security → WAF → Rate limiting rules*), or put the Worker behind Cloudflare Access.

## Run locally

```sh
npm install
npm run dev     # http://localhost:8787
```

## Deploy from the command line

```sh
npm install
npx wrangler login
npm run deploy
```

## How it works

- `src/index.ts`: the Worker. `GET /` serves the page; `POST /api/generate` takes `{"url": "..."}` and
  returns a PNG. Only `http://` and `https://` URLs up to 2048 bytes are accepted.
- `src/qr.ts`, `src/png.ts`: QR encoding (byte mode, error correction M, versions 1-40) and a
  1-bit transparent PNG writer.
- `src/index.html`: the UI.

Typical URLs encode in a few milliseconds; a URL near the 2048-character maximum can approach the
Workers Free plan's 10 ms CPU limit.

## License

MIT, see [LICENSE](LICENSE).
