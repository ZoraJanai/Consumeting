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
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
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
  const url = `${BASE}/info/${anilistId}.data`
  const res = await fetch(url, { headers: anidapHeaders() })
  if (!res.ok) throw new Error(`[anidap] info failed: ${res.status}`)

  const text = await res.text()
  console.log("[anidap] info raw response:", text.substring(0, 3000))

  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`[anidap] info response is not JSON: ${text.substring(0, 200)}`)
  }

  // Decode Next.js RSC dehydrated reference-graph array.
  // Format: flat array where objects use {"_N": M} meaning
  //   property(name=arr[N]) = arr[M].
  // We fully resolve the graph into a plain JS object, then extract the slug.
  let slug = ""
  let title = ""
  let image: string | undefined

  if (Array.isArray(raw)) {
    // Resolve a node: if it's an object with _N keys, rebuild with resolved keys/values
    function resolve(node: any, visited = new Set<number>()): any {
      if (node === null || typeof node !== "object" || Array.isArray(node)) return node
      const out: Record<string, any> = {}
      for (const k of Object.keys(node)) {
        const nameIdx = Number(k.replace("_", ""))
        const valIdx: number = node[k]
        if (isNaN(nameIdx) || typeof valIdx !== "number") {
          out[k] = node[k]
          continue
        }
        const name = raw[nameIdx]
        const val = raw[valIdx]
        if (visited.has(valIdx)) {
          out[String(name)] = "<circular>"
          continue
        }
        visited.add(valIdx)
        out[String(name)] = resolve(val, visited)
        visited.delete(valIdx)
      }
      return out
    }

    // The top-level object is at index 0; resolve it to get the full tree
    const tree = resolve(raw[0])
    console.log("[anidap] resolved tree keys:", JSON.stringify(Object.keys(tree)).substring(0, 300))

    // Navigate: tree["routes/info/page"]["data"]["animeData"]
    const routeKey = Object.keys(tree).find(k => k.includes("info"))
    const routeData = routeKey ? tree[routeKey] : tree
    const data = routeData?.data ?? routeData
    const animeData = data?.animeData ?? data

    console.log("[anidap] animeData keys:", JSON.stringify(Object.keys(animeData ?? {})).substring(0, 300))

    slug = animeData?.slug ?? animeData?.anidapId ?? animeData?.id ?? ""
    title =
      animeData?.titleEnglish ||
      animeData?.titleRomaji ||
      animeData?.title?.english ||
      animeData?.title?.romaji ||
      animeData?.title?.native ||
      animeData?.title ||
      animeData?.name ||
      ""
    image =
      animeData?.coverImage?.extraLarge ||
      animeData?.coverImage?.large ||
      animeData?.bannerImage ||
      animeData?.image ||
      ""

    // The info response sometimes embeds a pre-resolved episode list — log it so we can use it
    if (animeData?.episodes) {
      console.log("[anidap] embedded episodes type:", typeof animeData.episodes,
        Array.isArray(animeData.episodes) ? "len=" + animeData.episodes.length : "",
        JSON.stringify(animeData.episodes).substring(0, 200))
    }
  } else if (raw && typeof raw === "object") {
    slug = raw.slug || raw.anidapId || raw.id || ""
    title = raw.title?.english || raw.title?.romaji || raw.title || raw.name || slug
    image = raw.coverImage?.large || raw.bannerImage || raw.image
  }

  if (!slug) throw new Error(`[anidap] could not extract slug from response: ${text.substring(0, 300)}`)
  return { slug, title, image }
}

// ─────────────────────────────────────────────
// API: episode list
// ─────────────────────────────────────────────

export async function anidapFetchEpisodes(slug: string): Promise<AnidapEpisode[]> {
  const url = `${API}/episodes?id=${slug}`
  const res = await fetch(url, { headers: anidapHeaders(`${BASE}/watch?id=${slug}&ep=1`) })
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
  const res = await fetch(url, { headers: anidapHeaders(referer) })
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
      const res = await fetch(url, { headers: anidapHeaders(referer) })
      if (!res.ok) continue

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
