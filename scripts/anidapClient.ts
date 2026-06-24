// Anidap.se scraper client
// Handles slug resolution, episode list, server selection, and AES-GCM stream decryption.
import { fetch } from "scripting"

const BASE = "https://anidap.se"
const API = "https://chad.anidap.se/rest/api"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"

// ─────────────────────────────────────────────
// Decryption constants (ported from extractor.js)
// ─────────────────────────────────────────────

const Ce: number[] = [
  13, 27, 7, 19, 31, 11, 23, 37, 41, 43, 47, 53, 59, 61, 67, 71,
  73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151,
]
const ht = new Uint8Array(
  Array.from({ length: 32 }, (_, t) => (((t * 17 + 53) ^ (t * 23 + 79) ^ (t * 31 + 124)) & 255))
)
// Key epoch ≈ 263 minutes  ((6³ + 47) * 60_000)
const KEY_EPOCH_MS = (6 * 6 * 6 + 47) * 60 * 1000

const _Ie = (e: number, t: number, n: number): number =>
  (((e ^ t) << 1) ^ ((t ^ n) >> 1) ^ (e + t + n)) & 255

const _gt = (arr: Uint8Array, t: number): number =>
  arr[t % arr.length] ^ arr[(t * 7 + 11) % arr.length] ^ arr[(t * 13 + 17) % arr.length]

function _b64decode(s: string): Uint8Array {
  while (s.length % 4) s += "="
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function _xorTransform(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let r = 0; r < data.length; r++) {
    const a = r % key.length
    const c = key[a]
    const l = ((c << (r % 8)) | (c >>> (8 - (r % 8)))) & 255
    const i = (r * 7 + 13) & 255
    out[r] = data[r] ^ l ^ i ^ key[(a + 1) % key.length]
  }
  return out
}

async function _deriveKeys(timestamp: number): Promise<{ aesKey: CryptoKey; xorKey: Uint8Array }> {
  const e = Math.floor(timestamp / KEY_EPOCH_MS)
  const T = new Uint8Array(128)
  for (let i = 0; i < 128; i++) {
    const u = Ce[i % Ce.length]
    T[i] = (_gt(ht, i) ^ ((e + i * u) & 255) ^ ((i ^ u) & 255)) & 255
  }
  const N = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const u = T[i], m = T[i + 64]
    N[i] = u ^ _Ie(u, m, (e >>> (i % 16)) & 255)
  }
  const R = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    const u = N[i], m = N[i + 32], d = Ce[(i * 3 + 7) % Ce.length]
    R[i] = (u ^ m ^ ((u + m + d) & 255)) & 255
  }
  const xorKey = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    const u = R[i], m = R[i + 16]
    const d = (((u << 3) | (u >>> 5)) ^ ((m << 5) | (m >>> 3))) & 255
    xorKey[i] = (d ^ ((e >>> (i * 2)) & 255)) & 255
  }
  const C = new Uint8Array(48)
  for (let i = 0; i < 48; i++) {
    const u = (i * 7 + 11) % 32, m = (i * 13 + 17) % 32, d = (i * 19 + 23) % 32
    C[i] = (_Ie(R[u], R[m], R[d]) ^ ((e >>> (i % 24)) & 255) ^ _gt(ht, i * 3)) & 255
  }
  const L = new Uint8Array(32)
  for (let round = 0; round < 3; round++) {
    for (let u2 = 0; u2 < 32; u2++) {
      const prev = round === 0 ? C[u2] : L[u2]
      const d2 = C[(u2 * 5 + 7) % 48]
      const p2 = C[(u2 * 11 + 13) % 48]
      L[u2] = (_Ie(prev, d2, p2) ^ C[(u2 + round * 16) % 48]) & 255
    }
  }
  const aesKey = await globalThis.crypto.subtle.importKey(
    "raw", L, { name: "AES-GCM" }, false, ["decrypt"]
  )
  return { aesKey, xorKey }
}

async function _decryptData(encryptedBase64: string): Promise<string> {
  const attempt = async (ts: number): Promise<string> => {
    const { aesKey, xorKey } = await _deriveKeys(ts)
    const decoded = _b64decode(encryptedBase64)
    const iv = decoded.slice(0, 12)
    const ciphertext = decoded.slice(12)
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv }, aesKey, ciphertext
    )
    return new TextDecoder().decode(_xorTransform(new Uint8Array(plain), xorKey))
  }
  try {
    return await attempt(Date.now())
  } catch {
    return await attempt(Date.now() - KEY_EPOCH_MS)
  }
}

// ─────────────────────────────────────────────
// CORS proxy helper (cors.otakuu.se)
// ─────────────────────────────────────────────

function _encodeProxyPath(url: string): string {
  return Array.from(url)
    .map(c => (c.charCodeAt(0) ^ 0x89).toString(16).padStart(2, "0"))
    .join("")
}

function wrapCorsProxy(rawUrl: string): string {
  if (rawUrl.includes("cors.otakuu.se")) return rawUrl
  const origin = encodeURIComponent(new URL(rawUrl).origin)
  return `https://cors.otakuu.se/media/${_encodeProxyPath(rawUrl)}?origin=${origin}`
}

// ─────────────────────────────────────────────
// Request headers
// ─────────────────────────────────────────────

function anidapHeaders(referer?: string): Record<string, string> {
  return {
    "user-agent": UA,
    "referer": referer ?? (BASE + "/"),
    "accept": "application/json, */*",
    "accept-language": "en-US,en;q=0.9",
  }
}

async function anidapFetch(url: string, referer?: string, timeoutMs = 12000): Promise<Response> {
  console.log("[anidap] fetch:", url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: anidapHeaders(referer),
      signal: controller.signal as any,
    })
    console.log("[anidap] response:", res.status, url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("/") + 30))
    return res
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export interface AnidapInfo {
  slug: string
  title: string
  image?: string
}

export interface AnidapEpisode {
  number: number
  hasSub: boolean
  hasDub: boolean
  hasHsub?: boolean
}

// ─────────────────────────────────────────────
// API: resolve AniList ID → slug + metadata
// ─────────────────────────────────────────────

export async function anidapResolveSlug(anilistId: string | number): Promise<AnidapInfo> {
  const id = String(anilistId)

  // If already in "anidap:slug" format (cached entry re-fetch), extract slug directly
  if (id.startsWith("anidap:")) {
    const slug = id.replace(/^anidap:/, "")
    console.log("[anidap] slug from cached source:", slug)
    const { title, image } = await anidapFetchInfo(slug)
    return { slug, title, image }
  }

  // Numeric AniList ID — fetch RSC payload to resolve slug
  const url = `${BASE}/info/${id}.data`
  const res = await anidapFetch(url)
  if (!res.ok) throw new Error(`[anidap] info fetch failed: ${res.status}`)

  const text = await res.text()
  console.log("[anidap] info raw response:", text.substring(0, 500))

  // The RSC payload is a streaming reference-graph array. The actual animeData
  // is behind a Suspense boundary (negative index = pending), but requestedId
  // always resolves and contains the slug as "anidap:<slug>".
  const slugMatch = /"anidap:([a-z0-9][a-z0-9-]+)"/.exec(text)
  if (!slugMatch) throw new Error(`[anidap] could not extract slug from response: ${text.substring(0, 300)}`)

  const slug = slugMatch[1]
  console.log("[anidap] extracted slug:", slug)

  const { title, image } = await anidapFetchInfo(slug)
  return { slug, title, image }
}

async function anidapFetchInfo(slug: string): Promise<{ title: string; image?: string }> {
  const url = `${API}/info?id=${slug}`
  try {
    const res = await anidapFetch(url, `${BASE}/info/${slug}`)
    if (!res.ok) {
      console.log("[anidap] REST info not available:", res.status, "— using slug as title")
      return { title: slug }
    }
    const raw = await res.json()
    const d = raw.data ?? raw
    console.log("[anidap] REST info keys:", JSON.stringify(Object.keys(d ?? {})).substring(0, 200))
    const title =
      d?.titleEnglish || d?.titleRomaji ||
      d?.title?.english || d?.title?.romaji || d?.title?.native ||
      d?.title || d?.name || slug
    const image =
      d?.coverImage?.extraLarge || d?.coverImage?.large ||
      d?.bannerImage || d?.image || undefined
    return { title, image }
  } catch (err) {
    console.log("[anidap] REST info error:", String(err), "— using slug as title")
    return { title: slug }
  }
}

// ─────────────────────────────────────────────
// API: episode list
// ─────────────────────────────────────────────

export async function anidapFetchEpisodes(slug: string): Promise<AnidapEpisode[]> {
  const url = `${API}/episodes?id=${slug}`
  const res = await anidapFetch(url, `${BASE}/watch?id=${slug}&ep=1`)
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)")
    throw new Error(`[anidap] episodes failed: ${res.status} — ${body.substring(0, 300)}`)
  }

  const raw = await res.json()
  const list: any[] = Array.isArray(raw) ? raw : (raw.episodes || raw.data || [])

  return list
    .filter((ep: any) => ep && typeof ep.number === "number")
    .map((ep: any) => ({
      number: ep.number,
      hasSub: ep.hasSub !== false,
      hasDub: ep.hasDub === true,
      hasHsub: ep.hasHsub === true,
    }))
}

// ─────────────────────────────────────────────
// API: servers for episode
// ─────────────────────────────────────────────

export interface AnidapServer {
  name: string
  type: "sub" | "dub" | "hsub"
}

export async function anidapFetchServers(slug: string, ep: number): Promise<AnidapServer[]> {
  const referer = `${BASE}/watch?id=${slug}&ep=${ep}&type=sub`
  const url = `${API}/servers?id=${slug}&ep=${ep}`
  const res = await anidapFetch(url, referer)
  if (!res.ok) throw new Error(`[anidap] servers failed: ${res.status}`)

  const raw = await res.json()
  const data = raw.data ?? raw

  const out: AnidapServer[] = []
  for (const key of Object.keys(data)) {
    if (key.endsWith("Providers")) {
      const type = key.replace("Providers", "") as "sub" | "dub" | "hsub"
      for (const name of (data[key] as string[])) {
        out.push({ name, type })
      }
    }
  }
  return out
}

// ─────────────────────────────────────────────
// API: fetch + decrypt stream sources
// Returns quality map e.g. { "-sub": "https://...", "-dub": "https://..." }
// ─────────────────────────────────────────────

export async function anidapFetchSources(
  slug: string,
  ep: number,
  servers: AnidapServer[]
): Promise<Record<string, string>> {
  const map: Record<string, string> = {}

  // Attempt each type once; stop after we have sub + dub (or exhausted servers)
  const attempted = new Set<string>()
  for (const srv of servers) {
    const key = `-${srv.type}`
    if (map[key]) continue
    if (attempted.has(srv.name + srv.type)) continue
    attempted.add(srv.name + srv.type)

    try {
      const referer = `${BASE}/watch?id=${slug}&ep=${ep}&type=${srv.type}&provider=${srv.name}`
      const url = `${API}/sources?id=${slug}&ep=${ep}&host=${srv.name}&type=${srv.type}`
      const res = await anidapFetch(url, referer)
      if (!res.ok) { console.log("[anidap] sources non-ok:", res.status, srv.name, srv.type); continue }

      const body = await res.json()
      const encrypted: string = body.data
      if (!encrypted) continue

      const decrypted = await _decryptData(encrypted)
      const parsed = JSON.parse(decrypted)
      const rawUrl: string = parsed.sources?.[0]?.url ?? parsed.sources?.[0]?.file ?? ""
      if (!rawUrl) continue

      map[key] = wrapCorsProxy(rawUrl)
    } catch (err) {
      console.error(`[anidap] source error (${srv.name}/${srv.type}):`, String(err))
    }
  }
  return map
}
