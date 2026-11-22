# qr-gen

A small QR code generator that runs on **Cloudflare Workers**.

- Enter a URL, get a **PNG with a transparent background** (black modules).
- Username/password login.
- Dark mode switch (remembers your choice, follows the OS by default).
- Activity log (sign-ins, failed sign-ins, QR codes generated, sign-outs) in the admin UI.
- No runtime dependencies: the QR encoder and PNG writer are included in `src/`.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-USERNAME/qr-gen)

> **Before the button works:** push this project to a public GitHub or GitLab repository, then replace
> `YOUR-USERNAME/qr-gen` in the button URL above with your own repository path.

Clicking the button walks you through:

1. Connecting your GitHub/GitLab account, which copies the repo into your account.
2. Entering the **username** and **password** (it reads these from `.dev.vars.example`). Pick a long
   password: the Worker is reachable from the public internet.
3. Deploying. Cloudflare builds the project and creates the Durable Object automatically.

Your app is then live at `https://qr-gen.<your-subdomain>.workers.dev`. Later pushes to the repo redeploy it.

If you skip the password, the app still deploys but **sign-in stays disabled** (with a message saying
why) until you add a `QR_GEN_PASSWORD` secret under *Workers & Pages → your Worker → Settings → Variables and Secrets*.
The placeholder value `change-me` from the example file is also rejected.

## Configuration

| Variable               | Default | Purpose                                         |
|------------------------|---------|-------------------------------------------------|
| `QR_GEN_USER`          | `admin` | Login username                                  |
| `QR_GEN_PASSWORD`      | none    | Login password (required, store as a secret)    |
| `QR_GEN_SESSION_HOURS` | `12`    | Session lifetime                                |

Set `QR_GEN_SESSION_HOURS` as a plain variable in the dashboard or under `"vars"` in `wrangler.jsonc`.
The `Secure` cookie flag is applied automatically whenever the site is served over HTTPS, so the old
`QR_GEN_COOKIE_SECURE` setting no longer exists.

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit the password
npm run dev                      # http://localhost:8787
```

## Deploy from the command line

```sh
npm install
npx wrangler login
npx wrangler secret put QR_GEN_PASSWORD
npm run deploy
```

## How it works

- `src/index.ts`: the Worker (routes, auth, validation). Same API as the original: `/api/login`,
  `/api/logout`, `/api/me`, `/api/generate`, `/api/logs`.
- `src/activity-log.ts`: a SQLite-backed Durable Object holding sessions, the activity log (last 1000
  entries) and the sign-in limiter. A Worker keeps no memory between requests, so this replaces the
  original's in-process state and the `/data` volume.
- `src/qr.ts`, `src/png.ts`: QR encoding (byte mode, error correction M, versions 1-40) and a
  1-bit transparent PNG writer.
- `src/index.html`: the UI, unchanged from the original.

Sign-in is limited to 10 attempts per IP per 15 minutes. For stronger protection against distributed
guessing, add a Cloudflare rate-limiting rule on `/api/login`.

Durable Objects with SQLite storage are available on the Workers Free plan. Typical URLs encode in a few
milliseconds; a URL near the 2048-character maximum can approach the Free plan's 10 ms CPU limit.
