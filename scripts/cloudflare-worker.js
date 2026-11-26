// ============================================================
// HypeAfnan Cloudflare CDN Worker
// ------------------------------------------------------------
// This Worker proxies:
//   1. /videos/*  -> Cloudflare R2 bucket "hypeafnan-videos" (R2 binding: VIDEOS)
//      (dispatch videos + covers — moved off Vercel egress; R2 = zero egress fees)
//   2. everything else -> Backblaze B2 (product images, as before)
//
// SETUP (one-time, in the Cloudflare dashboard):
//   1. R2 -> Create bucket: "hypeafnan-videos"
//   2. Upload media: node scripts/uploadDispatchVideosToR2.mjs (from the repo)
//   3. Workers -> hypeafnan-cdn -> Settings -> Bindings:
//        Add binding -> R2 bucket -> variable name: VIDEOS -> bucket: hypeafnan-videos
//   4. Paste this file into the Worker editor (or deploy via wrangler) -> Deploy
//   5. Test video playback (seek, mobile, autoplay) BEFORE setting VIDEO_CDN_BASE
//      in Vercel — that env var is the cutover switch for the app.
//
// BENEFITS:
// - Videos: R2 storage is ~free at this size and egress is ALWAYS free
// - Videos keep working even while Vercel bandwidth is exhausted
// - Images: Cloudflare edge caches globally; Backblaze <-> Cloudflare egress is free
// ============================================================

const B2_BUCKET_URL = "https://f005.backblazeb2.com/file/HypeAfnan-images";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- /videos/* -> R2 bucket (binding: VIDEOS) ----------
    if (url.pathname.startsWith("/videos/") && env.VIDEOS) {
      // Decode the URL-encoded folder/file names (spaces etc.)
      const key = decodeURIComponent(url.pathname.slice("/videos/".length));
      const cache = caches.default;
      const rangeHeader = request.headers.get("range");

      // Cloudflare's cache never stores 206 responses — only cache full requests
      if (!rangeHeader) {
        const cached = await cache.match(request);
        if (cached) return cached;
      }

      let object;
      if (rangeHeader) {
        // Range: bytes=start-end | bytes=start- | bytes=-suffix
        const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
        if (m) {
          const offset = parseInt(m[1], 10);
          const opts = m[2]
            ? { range: { offset, length: parseInt(m[2], 10) - offset + 1 } }
            : { range: { offset } };
          object = await env.VIDEOS.get(key, opts);
        } else {
          object = await env.VIDEOS.get(key);
        }
      } else {
        object = await env.VIDEOS.get(key);
      }

      if (!object) {
        return new Response(`Video not found: ${key}`, { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Access-Control-Allow-Origin", "*");
      if (!headers.get("Content-Type")) headers.set("Content-Type", "video/mp4");

      let status = 200;
      if (object.range) {
        // Partial content — required for video seeking
        const start = object.range.offset;
        const end = "length" in object.range && object.range.length != null
          ? start + object.range.length - 1
          : object.size - 1;
        headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
        status = 206;
      }

      const response = new Response(object.body, { status, headers });
      // Cache only complete responses at the edge
      if (!rangeHeader) {
        ctx.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    }

    // ---------- everything else -> B2 images (unchanged behavior) ----------
    const b2Path = url.pathname; // e.g. /images/products/topokay-product-front-xxxx.webp
    const b2Url = `${B2_BUCKET_URL}${b2Path}`;

    // Check Cloudflare's cache first
    const cacheKey = new Request(b2Url, request);
    const cache = caches.default;
    let response = await cache.match(cacheKey);

    if (response) {
      // Cache hit — return instantly from Cloudflare edge
      return response;
    }

    // Cache miss — fetch from Backblaze
    response = await fetch(b2Url, {
      headers: {
        // Forward accept-encoding so B2 can serve compressed responses
        "Accept-Encoding": request.headers.get("Accept-Encoding") || "identity",
      },
    });

    if (!response.ok) {
      return new Response(`Image not found: ${b2Path}`, { status: response.status });
    }

    // Clone the response and add strong caching headers
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "public, max-age=31536000, immutable"); // Cache 1 year
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Vary", "Accept-Encoding");

    const cachedResponse = new Response(response.body, {
      status: response.status,
      headers,
    });

    // Store in Cloudflare cache for future requests
    ctx.waitUntil(cache.put(cacheKey, cachedResponse.clone()));

    return cachedResponse;
  },
};
