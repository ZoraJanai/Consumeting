// Local on-device HLS proxy.
//
// iOS AVPlayer (and the external players nPlayer/OutPlayer) cannot attach a
// custom Referer to its segment requests, but the kwik CDN requires
// `Referer: https://kwik.cx/` on the playlist AND every segment. Since our
// `fetch` CAN set arbitrary headers, we run a tiny local HTTP server that:
//   1. fetches the real m3u8 with the caller-supplied headers,
//   2. rewrites every segment / key / sub-playlist URL to loop back through us,
//   3. fetches each of those with the same headers and streams the bytes back.
//
// AVPlayer then plays `http://127.0.0.1:<port>/hls?...` with no headers needed.
// This only works while the app stays in the foreground (in-app playback),
// which is exactly how the built-in player uses it.

import { fetch } from "scripting"

const HLS_PATH = "/hls"
const SEG_PATH = "/seg"

let server: any = null
let baseUrl = ""
let starting: Promise<string> | null = null

function getQuery(req: any, key: string): string {
  const list = (req && req.queryParams) || []
  for (let i = 0; i < list.length; i++) {
    if (list[i].key === key) return list[i].value
  }
  return ""
}

function parseHeaders(raw: string): Record<string, string> {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    try {
      return JSON.parse(decodeURIComponent(raw))
    } catch {
      return {}
    }
  }
}

// queryParams values may arrive percent-encoded; decode only when needed.
function decodeUrlParam(v: string): string {
  if (!v) return v
  if (/^https?:\/\//i.test(v)) return v
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

/** Resolve a possibly-relative URL found in a playlist against its base. */
function resolveUrl(ref: string, base: string): string {
  const r = (ref || "").trim()
  if (!r) return r
  if (/^https?:\/\//i.test(r)) return r
  if (r.indexOf("//") === 0) return "https:" + r

  const m = base.match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i)
  const origin = m ? m[1] : ""
  const path = m && m[2] ? m[2] : "/"

  if (r.indexOf("/") === 0) return origin + r

  let dir = path.replace(/[^/]*$/, "")
  let rel = r
  while (rel.indexOf("../") === 0) {
    rel = rel.slice(3)
    dir = dir.replace(/[^/]*\/$/, "")
  }
  if (rel.indexOf("./") === 0) rel = rel.slice(2)
  return origin + dir + rel
}

function childUrl(kind: string, absUrl: string, hEnc: string): string {
  return baseUrl + kind + "?u=" + encodeURIComponent(absUrl) + "&h=" + hEnc
}

/** Rewrite playlist URIs (segments, keys, maps, variant playlists) through us. */
function rewritePlaylist(text: string, baseM3u8: string, headers: Record<string, string>): string {
  const hEnc = encodeURIComponent(JSON.stringify(headers))
  const lines = text.split(/\r?\n/)
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      out.push(line)
      continue
    }

    if (trimmed.charAt(0) === "#") {
      // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA carry URI="..."
      if (line.indexOf('URI="') >= 0) {
        line = line.replace(/URI="([^"]+)"/g, function (_m, uri) {
          const abs = resolveUrl(uri, baseM3u8)
          return 'URI="' + childUrl(SEG_PATH, abs, hEnc) + '"'
        })
      }
      out.push(line)
      continue
    }

    const abs = resolveUrl(trimmed, baseM3u8)
    const isPlaylist = /\.m3u8($|\?)/i.test(abs)
    out.push(childUrl(isPlaylist ? HLS_PATH : SEG_PATH, abs, hEnc))
  }

  return out.join("\n")
}

async function handleHls(req: any): Promise<any> {
  try {
    const u = decodeUrlParam(getQuery(req, "u"))
    const headers = parseHeaders(getQuery(req, "h"))
    if (!u) {
      return HttpResponse.raw(400, "Bad Request", {
        headers: { "Content-Type": "text/plain" },
        body: Data.fromRawString("missing url", "utf-8"),
      })
    }

    const resp = await fetch(u, { headers })
    const text = await resp.text()

    if (!resp.ok) {
      console.error("[localProxy] playlist HTTP", resp.status, text.slice(0, 160))
    }

    const rewritten = rewritePlaylist(text, u, headers)
    return HttpResponse.raw(200, "OK", {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      body: Data.fromRawString(rewritten, "utf-8"),
    })
  } catch (e) {
    console.error("[localProxy] handleHls error", String(e))
    return HttpResponse.raw(502, "Bad Gateway", {
      headers: { "Content-Type": "text/plain" },
      body: Data.fromRawString(String(e), "utf-8"),
    })
  }
}

async function handleSeg(req: any): Promise<any> {
  try {
    const u = decodeUrlParam(getQuery(req, "u"))
    const headers = parseHeaders(getQuery(req, "h"))
    if (!u) {
      return HttpResponse.raw(400, "Bad Request", {
        headers: { "Content-Type": "text/plain" },
        body: Data.fromRawString("missing url", "utf-8"),
      })
    }

    // Forward range requests so seeking works.
    const reqHeaders = (req && req.headers) || {}
    const range = reqHeaders["range"] || reqHeaders["Range"]
    if (range) headers["Range"] = range

    const resp = await fetch(u, { headers })
    const data = await resp.data()

    const respHeaders: Record<string, string> = {
      "Content-Type": resp.headers.get("content-type") || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    }
    const contentRange = resp.headers.get("content-range")
    if (contentRange) respHeaders["Content-Range"] = contentRange
    const acceptRanges = resp.headers.get("accept-ranges")
    if (acceptRanges) respHeaders["Accept-Ranges"] = acceptRanges

    return HttpResponse.raw(resp.status || 200, resp.statusText || "OK", {
      headers: respHeaders,
      body: data,
    })
  } catch (e) {
    console.error("[localProxy] handleSeg error", String(e))
    return HttpResponse.raw(502, "Bad Gateway", {
      headers: { "Content-Type": "text/plain" },
      body: Data.fromRawString(String(e), "utf-8"),
    })
  }
}

/** Start the proxy if needed and return its base URL (http://127.0.0.1:<port>). */
export async function ensureHlsProxy(): Promise<string> {
  if (server && server.state === "running" && baseUrl) return baseUrl
  if (starting) return starting

  starting = (async () => {
    const s = new HttpServer()
    s.registerAsyncHandler(HLS_PATH, handleHls)
    s.registerAsyncHandler(SEG_PATH, handleSeg)

    const err = s.start({ port: 0, forceIPv4: true })
    if (err) {
      throw new Error("Local proxy failed to start: " + err)
    }

    server = s
    baseUrl = "http://127.0.0.1:" + String(s.port)
    console.log("[localProxy] running at", baseUrl)
    return baseUrl
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

/** Build the localhost playlist URL the player should open. */
export function proxiedPlaylistUrl(realM3u8: string, headers: Record<string, string>): string {
  const hEnc = encodeURIComponent(JSON.stringify(headers || {}))
  return baseUrl + HLS_PATH + "?u=" + encodeURIComponent(realM3u8) + "&h=" + hEnc
}

export function stopHlsProxy() {
  if (server) {
    try {
      server.stop()
    } catch {
      /* ignore */
    }
  }
  server = null
  baseUrl = ""
}
