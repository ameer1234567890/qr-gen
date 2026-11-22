import indexHtml from "./index.html";
import { ActivityLog } from "./activity-log";
import { encodeQr } from "./qr";
import { renderPng } from "./png";

export { ActivityLog };

interface Env {
  ACTIVITY_LOG: DurableObjectNamespace<ActivityLog>;
  QR_GEN_USER?: string;
  QR_GEN_PASSWORD?: string;
  QR_GEN_SESSION_HOURS?: string;
}

const COOKIE = "qrgen_session";
const MAX_BODY = 16 * 1024;
const MAX_URL_BYTES = 2048;
const LOGIN_LIMIT = 10; // sign-in attempts per IP...
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // ...per 15 minutes
const FAIL_DELAY_MS = 700; // slows guessing, like the original

// ---------- helpers ----------

const truncate = (s: string, max: number) => Array.from(s).slice(0, max).join("");

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

const err = (status: number, message: string, extra: HeadersInit = {}) => json({ error: message }, status, extra);

function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Constant-time string comparison (compares fixed-length digests). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function newToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function validateUrl(raw: unknown): { url: string } | { error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { error: "Enter a URL." };
  if (new TextEncoder().encode(s).length > MAX_URL_BYTES) {
    return { error: "That URL is too long (2048 characters max)." };
  }
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return { error: "Enter a valid URL, for example https://example.com" };
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    return { error: "Only http:// and https:// URLs are supported." };
  }
  return { url: s };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// A value left over from the example file must never work as a real password.
const isPlaceholder = (pw: string) => /^change-?me/i.test(pw);

// ---------- app ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const log = env.ACTIVITY_LOG.get(env.ACTIVITY_LOG.idFromName("main"));
    const ip = truncate(request.headers.get("cf-connecting-ip") ?? "-", 64);
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const now = () => iso(Date.now());
    const record = (user: string, action: string, detail: string) =>
      ctx.waitUntil(
        log.record({ ts: now(), user: truncate(user, 64), action, detail: truncate(detail, 300), ip }),
      );

    const ttlSeconds = Math.max(1, parseInt(env.QR_GEN_SESSION_HOURS ?? "", 10) || 12) * 3600;
    const secure = url.protocol === "https:" ? "; Secure" : "";
    const cookieHeader = (value: string, maxAge: number) =>
      `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;

    const sessionUser = async (): Promise<{ user: string; hash: string } | null> => {
      const token = getCookie(request, COOKIE);
      if (!token) return null;
      const hash = hex(await sha256(token));
      const user = await log.getSession(hash);
      return user ? { user, hash } : null;
    };

    const route = `${request.method} ${url.pathname}`;
    const known = ["/", "/api/login", "/api/logout", "/api/me", "/api/generate", "/api/logs"];

    switch (route) {
      case "GET /":
      case "HEAD /":
        return new Response(request.method === "HEAD" ? null : indexHtml, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
              "img-src 'self' blob:; connect-src 'self'; form-action 'self'; " +
              "base-uri 'none'; frame-ancestors 'none'",
            "x-frame-options": "DENY",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store",
          },
        });

      case "POST /api/login": {
        const configuredPassword = env.QR_GEN_PASSWORD ?? "";
        if (!configuredPassword || isPlaceholder(configuredPassword)) {
          return err(503, "Sign-in is disabled until a password is set. Add the QR_GEN_PASSWORD secret to this Worker.");
        }
        const body = await readJson(request);
        if (!body) return err(400, "Invalid request.");
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";

        const attemptId = await log.beginLogin(
          ip, now(), iso(Date.now() - LOGIN_WINDOW_MS), LOGIN_LIMIT,
        );
        if (attemptId === null) return err(429, "Too many sign-in attempts. Try again in a few minutes.");

        const configuredUser = env.QR_GEN_USER || "admin";
        const userOk = await safeEqual(username, configuredUser);
        const passOk = await safeEqual(password, configuredPassword);
        if (!(userOk && passOk)) {
          await log.failLogin(attemptId, truncate(username, 64));
          await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
          return err(401, "Incorrect username or password.");
        }

        const token = newToken();
        await log.completeLogin(attemptId, configuredUser, hex(await sha256(token)), Date.now() + ttlSeconds * 1000);
        return json({ user: configuredUser }, 200, { "set-cookie": cookieHeader(token, ttlSeconds) });
      }

      case "POST /api/logout": {
        const session = await sessionUser();
        if (session) {
          await log.deleteSession(session.hash);
          record(session.user, "logout", "Signed out");
        }
        return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
      }

      case "GET /api/me": {
        const session = await sessionUser();
        return session ? json({ user: session.user }) : err(401, "Sign in required.");
      }

      case "POST /api/generate": {
        const session = await sessionUser();
        if (!session) return err(401, "Sign in required.");
        const body = await readJson(request);
        if (!body) return err(400, "Invalid request.");
        const checked = validateUrl(body.url);
        if ("error" in checked) return err(400, checked.error);

        let png: Uint8Array<ArrayBuffer>;
        try {
          png = await renderPng(encodeQr(checked.url));
        } catch (e) {
          return err(422, e instanceof Error ? e.message : "Could not encode URL.");
        }
        record(session.user, "generate", checked.url);
        return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
      }

      case "GET /api/logs": {
        const session = await sessionUser();
        if (!session) return err(401, "Sign in required.");
        return json(await log.list());
      }
    }

    return known.includes(url.pathname) ? err(405, "Method not allowed.") : err(404, "Not found.");
  },
} satisfies ExportedHandler<Env>;
