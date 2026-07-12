import { fetch } from "scripting"

// ── Constants ─────────────────────────────────────────────────────────────────
const API       = "https://api.allanime.day/api"
const REFERER   = "https://youtu-chan.com"
const BASE      = "https://allanime.day"
const UA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0"
const KEY_PHRASE = "Xot36i3lK3:v1"

// ── AES-256-CTR decryption ────────────────────────────────────────────────────
// ani-cli response format:
//   [0]       1 byte  — skipped
//   [1..12]  12 bytes — IV
//   [13..n-16] bytes  — ciphertext
//   [n-16..n] 16 bytes — tail (skipped)
// Counter block = IV + 0x00000002 (4-byte big-endian suffix)

let _key: CryptoKey | null = null

async function getKey(): Promise<CryptoKey> {
  if (_key) return _key
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY_PHRASE))
  _key = await crypto.subtle.importKey("raw", raw, { name: "AES-CTR" }, false, ["decrypt"])
  return _key
}

async function decryptTobeparsed(tobeparsed: string): Promise<any> {
  const key = await getKey()
  const bin = Uint8Array.from(atob(tobeparsed), c => c.charCodeAt(0))
  const iv  = bin.slice(1, 13)
  const counter = new Uint8Array(16)
  counter.set(iv, 0)
  // last 4 bytes of counter = 0x00000002 big-endian
  counter[12] = 0; counter[13] = 0; counter[14] = 0; counter[15] = 2
  const ct = bin.slice(13, bin.length - 16)
  const plain = await crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 128 }, key, ct)
  return JSON.parse(new TextDecoder().decode(plain))
}

// ── "--" hex-obfuscated provider URL decoder ──────────────────────────────────
// ani-cli source: sed map of hex pairs → characters
const HEX2CHAR: Record<string, string> = {
  '79':'A','7a':'B','7b':'C','7c':'D','7d':'E','7e':'F','7f':'G',
  '70':'H','71':'I','72':'J','73':'K','74':'L','75':'M','76':'N','77':'O',
  '68':'P','69':'Q','6a':'R','6b':'S','6c':'T','6d':'U','6e':'V','6f':'W',
  '60':'X','61':'Y','62':'Z',
  '59':'a','5a':'b','5b':'c','5c':'d','5d':'e','5e':'f','5f':'g',
  '50':'h','51':'i','52':'j','53':'k','54':'l','55':'m','56':'n','57':'o',
  '48':'p','49':'q','4a':'r','4b':'s','4c':'t','4d':'u','4e':'v','4f':'w',
  '40':'x','41':'y','42':'z',
  '08':'0','09':'1','0a':'2','0b':'3','0c':'4','0d':'5','0e':'6','0f':'7',
  '00':'8','01':'9',
  '15':'-','16':'.','67':'_','46':'~',
  '02':':','17':'/','07':'?','1b':'#',
  '63':'[','65':']','78':'@','19':'!',
  '1c':'$','1e':'&','10':'(','11':')',
  '12':'*','13':'+','14':',','03':';',
  '05':'=','1d':'%',
}

function deobfuscate(encoded: string): string {
  const pairs = encoded.slice(2).match(/.{2}/g) ?? []
  return pairs.map(p => HEX2CHAR[p] ?? "").join("")
}

// ── Core API helper ───────────────────────────────────────────────────────────
async function apiPost(query: string, variables: Record<string, any>): Promise<any> {
  const resp = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Referer":      REFERER,
      "User-Agent":   UA,
      "Origin":       REFERER,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!resp.ok) throw new Error(`[AllAnime] HTTP ${resp.status}`)

  const json = await resp.json()
  const raw  = JSON.stringify(json)

  if (raw.includes('"tobeparsed"')) {
    const m = raw.match(/"tobeparsed":"([^"]*)"/)
    if (m) return decryptTobeparsed(m[1])
  }
  return json
}

// ── GraphQL queries (verbatim from ani-cli) ───────────────────────────────────
const SEARCH_GQL = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){shows(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name availableEpisodes thumbnail __typename}}}`

const EPISODES_GQL = `query($showId:String!){show(_id:$showId){_id availableEpisodesDetail}}`

const STREAM_GQL = `query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){episode(showId:$showId translationType:$translationType episodeString:$episodeString){episodeString sourceUrls}}`

// ── Public types ──────────────────────────────────────────────────────────────
export type AllAnimeMode = "sub" | "dub"

export type AllAnimeResult = {
  id:           string
  title:        string
  episodeCount: number
  img:          string
}

// ── Search ────────────────────────────────────────────────────────────────────
export async function allAnimeSearch(
  query: string,
  mode: AllAnimeMode = "sub"
): Promise<AllAnimeResult[]> {
  const data = await apiPost(SEARCH_GQL, {
    search:          { allowAdult: false, allowUnknown: false, query },
    limit:           40,
    page:            1,
    translationType: mode,
    countryOrigin:   "ALL",
  })

  const edges: any[] =
    data?.data?.shows?.edges ??
    data?.shows?.edges ??
    []

  return edges.map(e => ({
    id:           String(e._id),
    title:        String(e.name),
    episodeCount: Number(e.availableEpisodes?.[mode] ?? 0),
    img:          String(e.thumbnail ?? ""),
  }))
}

// ── Episode list ──────────────────────────────────────────────────────────────
export async function allAnimeGetEpisodes(
  showId: string,
  mode:   AllAnimeMode = "sub"
): Promise<string[]> {
  const data = await apiPost(EPISODES_GQL, { showId })
  const detail =
    data?.data?.show?.availableEpisodesDetail ??
    data?.show?.availableEpisodesDetail ??
    {}
  const list: string[] = detail[mode] ?? []
  // Sort numerically (API may return out of order)
  return list.slice().sort((a, b) => parseFloat(a) - parseFloat(b))
}

// ── Stream URL ────────────────────────────────────────────────────────────────
// Priority order mirrors ani-cli providers 1→4 (wixmp > youtube > sharepoint > mp4upload)
const PROVIDER_PRIORITY = ["Default", "Luf-mp4", "Yt-mp4", "S-mp4", "Mp4-Luf", "Ac"]

export async function allAnimeGetStreamUrl(
  showId:     string,
  episodeNum: string,
  mode:       AllAnimeMode = "sub"
): Promise<string | null> {
  const data = await apiPost(STREAM_GQL, {
    showId,
    translationType: mode,
    episodeString:   episodeNum,
  })

  const raw = JSON.stringify(data?.data?.episode ?? data?.episode ?? data)

  // Extract all {sourceUrl, sourceName} pairs
  type Src = { url: string; name: string }
  const sources: Src[] = []
  for (const m of raw.matchAll(/"sourceUrl":"([^"]*)"[^}]*"sourceName":"([^"]*)"/g)) {
    sources.push({
      url:  m[1].replace(/\\u002F/g, "/").replace(/\\/g, ""),
      name: m[2],
    })
  }

  if (sources.length === 0) {
    console.log("[AllAnime] no sources for", showId, episodeNum)
    return null
  }

  // Pick best provider
  let chosen: Src | undefined
  for (const preferred of PROVIDER_PRIORITY) {
    chosen = sources.find(s => s.name === preferred)
    if (chosen) break
  }
  chosen = chosen ?? sources[0]

  let path = chosen.url
  if (path.startsWith("--")) {
    path = deobfuscate(path).replace("/clock", "/clock.json")
  }

  // Fetch actual stream endpoint
  const streamResp = await fetch(BASE + path, {
    headers: { "Referer": REFERER, "User-Agent": UA },
  })
  if (!streamResp.ok) {
    console.log("[AllAnime] stream endpoint failed:", streamResp.status, path)
    return null
  }

  const sJson = JSON.stringify(await streamResp.json())

  // wixmp: "link":"url","resolutionStr":"1080p"
  const byRes = [...sJson.matchAll(/"link":"([^"]*)"[^}]*"resolutionStr":"([^"]*)"/g)]
    .map(m => ({ url: m[1].replace(/\\u002F/g, "/"), res: parseInt(m[2]) || 0 }))
    .sort((a, b) => b.res - a.res)
  if (byRes.length > 0) return byRes[0].url

  // m3u8_refr pattern (master.m3u8 with referer)
  const masterM3u8 = sJson.match(/"hls","url":"([^"]*)"[^}]*"hardsub_lang":"en-US"/)
  if (masterM3u8) return masterM3u8[1].replace(/\\u002F/g, "/")

  // Fallback: any m3u8 URL in response
  const anyM3u8 = sJson.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/)
  return anyM3u8 ? anyM3u8[1] : null
}

// ── Episode ID helpers ────────────────────────────────────────────────────────
// AllAnime episode IDs are encoded as "allanime:{showId}:{epNum}:{mode}"
// This lets episode.ts detect them and route to the right extractor.

export function encodeAllAnimeId(showId: string, epNum: string, mode: AllAnimeMode): string {
  return `allanime:${showId}:${epNum}:${mode}`
}

export function decodeAllAnimeId(id: string): { showId: string; epNum: string; mode: AllAnimeMode } | null {
  if (!id.startsWith("allanime:")) return null
  const parts = id.slice("allanime:".length).split(":")
  if (parts.length < 3) return null
  return {
    showId: parts[0],
    epNum:  parts[1],
    mode:   (parts[2] === "dub" ? "dub" : "sub") as AllAnimeMode,
  }
}

export function isAllAnimeId(id: string): boolean {
  return id.startsWith("allanime:")
}
