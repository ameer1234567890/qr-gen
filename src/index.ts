import indexHtml from "./index.html";
import { encodeQr } from "./qr";
import { renderPng } from "./png";

const MAX_BODY = 16 * 1024;
const MAX_URL_BYTES = 2048;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const err = (status: number, message: string) => json({ error: message }, status);

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

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;

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

      case "POST /api/generate": {
        const body = await readJson(request);
        if (!body) return err(400, "Invalid request.");
        const checked = validateUrl(body.url);
        if ("error" in checked) return err(400, checked.error);
        try {
          const png = await renderPng(encodeQr(checked.url));
          return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
        } catch (e) {
          return err(422, e instanceof Error ? e.message : "Could not encode URL.");
        }
      }
    }

    return pathname === "/" || pathname === "/api/generate" ? err(405, "Method not allowed.") : err(404, "Not found.");
  },
} satisfies ExportedHandler;
