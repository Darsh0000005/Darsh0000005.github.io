import type { Config } from "@netlify/functions";

// Fallback for when the browser can't read FlipHTML5 files directly (CORS).
// Only fliphtml5.com hosts are allowed so this can't be used as an open proxy.
const ALLOWED_HOST = /(^|\.)fliphtml5\.com$/i;
const PASS_HEADERS = ["content-type", "last-modified", "etag"];

export default async (req: Request) => {
  const target = new URL(req.url).searchParams.get("url");
  let url: URL;
  try {
    url = new URL(target ?? "");
  } catch {
    return new Response("Missing or invalid url parameter", { status: 400 });
  }
  if (url.protocol !== "https:" || !ALLOWED_HOST.test(url.hostname)) {
    return new Response("Only https://*.fliphtml5.com URLs are allowed", { status: 403 });
  }

  const [id1, id2] = url.pathname.split("/").filter(Boolean);
  const referer = id1 && id2 ? `https://online.fliphtml5.com/${id1}/${id2}/` : "https://online.fliphtml5.com/";

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Referer: referer,
      },
    });
  } catch {
    return new Response("Couldn't reach FlipHTML5", { status: 502 });
  }

  // fetch() already decompressed the body, so content-length/encoding from
  // upstream would be wrong here; pass only headers that still hold.
  const headers = new Headers();
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", upstream.ok ? "public, max-age=86400" : "no-store");

  return new Response(upstream.body, { status: upstream.status, headers });
};

export const config: Config = {
  path: "/api/proxy",
  method: "GET",
};
