// Episode handling — direct animepahe scraping (animepahe-api repo style)
import { fetch } from "scripting"
import { loadSetting, saveSetting, STORAGE_KEYS } from "./storage"
import { hideOverlay, showOverlay } from "../Pages/Loading"
import { addCache, addQueue } from "./cache"
import { saveData } from "./data"
import { BaseInfo } from "./search"
import {
  directFetchPlayPage,
  getDirectBaseUrl,
  paheFetchStreamingSourcesFromApi,
} from "./animepaheClient"
import { paheHeaders } from "./animepaheSession"

// ---- Types ----

type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
  paheID?: string
}

export type QualityMap = Record<string, string>

type EntryType = {
  name: string
  ids: string[]
  episode: string
  total: string
  id: string
  img: string
}

export type DownloadAnime = {
  name: string
  source: string
  episodes: string
  img: string
  links: string[]
  isUnread: boolean
  paheID?: string
}

// ---- Defaults & Storage Keys ----

export const PlaceholderEntry: EntryType = {
  name: "Name of Anime",
  ids: [],
  episode: "0",
  total: "99",
  id: "123456",
  img: ""
}

export const QualitiesOrder = [
  "-1080p BD",
  "-1080p",
  "-816p chi",
  "-720p",
  "-default",
  "-auto",
  "-480p",
  "-360p",
]

function sanitizeFilename(name: string): string {
  return name
    .replaceAll(":", " -")
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll("|", "-")
    .replaceAll("?", "")
    .replaceAll("*", "")
    .replaceAll("<", "")
    .replaceAll(">", "")
    .replaceAll('"', "")
    .replaceAll("'", "")
    .replaceAll("`", "")
    .replaceAll("$", "")
    .replaceAll("&", "and")
    .replaceAll(";", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replaceAll("{", "")
    .replaceAll("}", "")
    .replaceAll("#", "")
    .replaceAll("%", "")
    .trim()
}

function getRustProxyUrl(): string {
  return loadSetting(STORAGE_KEYS.RUST_PROXY_URL, 'https://rust-proxy-hvm4.onrender.com')
}

function useApiMode(): boolean {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").trim().length > 0
}

// ─── Kwik decrypt (ported from Aniyomi KwikExtractor.kt) ───────────────────
// Decodes the obfuscated form params hidden in the Kwik page HTML.
// The pattern ("fullString", ignored, "key", v1, v2, ignored) encodes
// the form action + _token using a custom base-v2 cipher keyed on `key`.
function kwikDecrypt(fullString: string, key: string, v1: number, v2: number): string {
  // Map each character in key to its first occurrence index
  const keyMap = new Map<string, number>()
  for (let i = 0; i < key.length; i++) {
    if (!keyMap.has(key[i])) keyMap.set(key[i], i)
  }

  const delimiter = key[v2]   // separator between encoded characters
  let result = ""
  let i = 0

  while (i < fullString.length) {
    const next = fullString.indexOf(delimiter, i)
    if (next === -1) break

    // Each digit in the encoded segment is a key-index; build a base-v2 number string
    let digits = ""
    for (let j = i; j < next; j++) {
      const idx = keyMap.get(fullString[j])
      digits += (idx !== undefined ? idx : -1).toString()
    }
    i = next + 1

    const code = parseInt(digits, v2) - v1
    if (isNaN(code)) break
    result += String.fromCharCode(code)
  }
  return result
}

// ─── MP4 extractor (Aniyomi approach: pahe.win + "/i" → kwik download page) ─
// AnimePahe.kt uses div#pickDownload <a> hrefs (pahe.win URLs), not data-src.
// paheWinUrl + "/i" redirects to the kwik download page (/f/ or /d/) which
// contains the encrypted POST form — completely different from the embed page.
//
// Two-step fetch mirrors Aniyomi's noRedirectClient → fetchKwikHtml pattern:
//  1. Follow the pahe.win/i redirect to get the actual kwik download URL
//  2. Re-fetch that URL with kwik.cx headers so the form HTML is clean
async function extractKwikMp4Url(paheWinUrl: string, animepaheBase: string): Promise<string> {
  // Step 1: resolve the pahe.win redirect to reach the kwik download page
  const redirectRes = await fetch(paheWinUrl + "/i", {
    headers: { "Referer": animepaheBase + "/" },
  })
  await redirectRes.text() // drain body; we only need the final URL
  const kwikDownloadUrl = redirectRes.url
  if (!kwikDownloadUrl || kwikDownloadUrl === paheWinUrl + "/i") {
    throw new Error("[kwikMp4] pahe.win redirect did not resolve")
  }

  // Step 2: fetch the kwik download page with kwik.cx headers (matches Aniyomi fetchKwikHtml)
  const kwikRes = await fetch(kwikDownloadUrl, {
    headers: {
      "Origin": "https://kwik.cx",
      "Referer": "https://kwik.cx/",
    },
  })
  const html = await kwikRes.text()

  // Step 3: decrypt the obfuscated form params
  const pm = /\("(\w+)",\d+,"(\w+)",(\d+),(\d+),\d+\)/.exec(html)
  if (!pm) throw new Error("[kwikMp4] decrypt params not found")

  const decrypted = kwikDecrypt(pm[1], pm[2], parseInt(pm[3], 10), parseInt(pm[4], 10))
  const action = /action="([^"]+)"/.exec(decrypted)?.[1]
  const token  = /value="([^"]+)"/.exec(decrypted)?.[1]
  if (!action || !token) throw new Error(`[kwikMp4] form parse failed: ${decrypted.substring(0, 200)}`)

  // Step 4: POST → CDN redirect; response.url is the final signed CDN URL
  const postRes = await fetch(action, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://kwik.cx",
      "Referer": kwikDownloadUrl,
    },
    body: `_token=${encodeURIComponent(token)}`,
  })

  const finalUrl = postRes.url
  if (!finalUrl || finalUrl === action) throw new Error(`[kwikMp4] no redirect (status ${postRes.status})`)
  return finalUrl
}

// ─── HLS extractor (Aniyomi: getHlsStreamUrl — eval packed JS, find m3u8) ──
async function extractKwikHlsUrl(kwikEmbedUrl: string, animepaheBase: string): Promise<string> {
  const response = await fetch(kwikEmbedUrl, {
    headers: paheHeaders({ referer: animepaheBase + "/", mode: "navigate" }),
  })
  if (!response.ok) throw new Error(`[kwikHls] fetch failed: ${response.status}`)

  const html = await response.text()
  const packedMatch = /(eval)(\(f.*?)(\n<\/script>)/s.exec(html)
  if (!packedMatch) throw new Error("[kwikHls] packed script not found")

  const unpacked = eval(packedMatch[2].replace("eval", ""))
  const m3u8Match = unpacked.match(/https.*?m3u8/)
  if (!m3u8Match) throw new Error("[kwikHls] m3u8 URL not found")
  return m3u8Match[0]
}

// ─── Unified extractor: MP4 first (paheWinUrl), HLS fallback (kwikEmbedUrl) ─
async function extractKwikUrl(
  kwikEmbedUrl: string,
  paheWinUrl: string | null,
  animepaheBase: string,
): Promise<string> {
  if (paheWinUrl) {
    try {
      return await extractKwikMp4Url(paheWinUrl, animepaheBase)
    } catch (mp4Err) {
      console.error("[kwik] MP4 failed, falling back to HLS:", String(mp4Err))
    }
  }
  return extractKwikHlsUrl(kwikEmbedUrl, animepaheBase)
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&middot;": "·",
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  }
  return text.replace(/&[a-z0-9#]+;/gi, entity => entities[entity] || entity)
}

// Extract pahe.win download hrefs from div#pickDownload (Aniyomi: downloadLinks)
function extractDownloadLinks(html: string): string[] {
  const start = html.indexOf('id="pickDownload"')
  if (start === -1) return []
  // Grab a generous window after the section start; direct <a> children come first
  const section = html.substring(start, start + 4000)
  const end = section.indexOf("</div>")
  const relevant = end !== -1 ? section.substring(0, end) : section
  const links: string[] = []
  const hrefRe = /<a[^>]+href="([^"]+)"/g
  let m
  while ((m = hrefRe.exec(relevant)) !== null) {
    links.push(m[1])
  }
  return links
}

// Parse both div#resolutionMenu buttons and div#pickDownload links, paired by
// index exactly as Aniyomi does (withIndex + downloadLinks.getOrNull(index)).
function parseResolutionMenu(html: string): { kwikUrl: string; paheWinUrl: string | null; quality: string }[] {
  const downloadLinks = extractDownloadLinks(html)

  const result: { kwikUrl: string; paheWinUrl: string | null; quality: string }[] = []
  const buttonRegex = /<button[^>]*class="dropdown-item[^"]*"[^>]*>([\s\S]*?)<\/button>/g
  let match
  let idx = 0

  while ((match = buttonRegex.exec(html)) !== null) {
    const fullButton = match[0]
    const innerText = match[1]
    const srcMatch = /data-src="([^"]*)"/.exec(fullButton)
    if (!srcMatch) { idx++; continue }

    const audioMatch = /data-audio="([^"]*)"/.exec(fullButton)
    const isEng = audioMatch?.[1]?.toLowerCase() === "eng"

    const textMatch = /^\s*(.*?)\s*(?:<span|$)/.exec(innerText)
    const quality = decodeHtmlEntities(textMatch ? textMatch[1].trim() : innerText.trim())

    if (!isEng) {
      result.push({
        kwikUrl: srcMatch[1],
        paheWinUrl: downloadLinks[idx] ?? null,
        quality,
      })
    }
    idx++
  }

  return result
}

async function scrapePlayPageSources(episodeId: string): Promise<QualityMap> {
  const html = await directFetchPlayPage(episodeId)
  const entries = parseResolutionMenu(html)
  const base = getDirectBaseUrl()
  const dict: QualityMap = {}

  for (const entry of entries) {
    try {
      const url = await extractKwikUrl(entry.kwikUrl, entry.paheWinUrl, base)
      const parts = entry.quality.split(" · ")
      const tag = "-" + (parts[1] ?? parts[0]).trim()
      dict[tag] = url
    } catch (err) {
      console.error(`[getAnimepaheSources] Failed quality ${entry.quality}:`, err)
    }
  }

  return dict
}

export async function getAnimepaheSources(episodeId: string): Promise<QualityMap> {
  // console.log("[getAnimepaheSources] Fetching:", episodeId)

  if (useApiMode()) {
    return paheFetchStreamingSourcesFromApi(episodeId)
  }

  return scrapePlayPageSources(episodeId)
}

// ---- Quality Selection ----

export function qualityAutoSelect(
  qualities: QualityMap,
  qualityOrder: string[],
): string | undefined {
  for (const q of qualityOrder) {
    if (qualities[q]) return qualities[q]
  }
  return undefined
}

// ---- Episode Number Logic ----

export function episodeNumber(number: number, total: number, action: string) {
  let output;

  switch (action) {
    case 'Next':
      if (total >= (number + 1)) {
        number++;
        output = number;
      } else {
        return -5;
      }
      break;
    
    case 'Resume':
      output = number;
      break;

    case 'Add':
      output = 0;
      break;
    
    case 'Jump':
      output = -2;
      break;

    case 'Continue':
      if (total == (number + 1)) {
        output = -3;
      } else {
        output = -1;
      }
      break;
      
    case 'Choose':
      output = -1;
      break;
    
    case 'Watch':
      if (total > 1) {
        output = -1;
      } else {
        output = 1;
      }
      break;
    
    case 'Download':
      if (total === 1) {
        output = -3;
      } else {
        output = -1;
      }
      break;

    case 'DownloadAll':
      if (number >= total) {
        output = -5;
      } else {
        output = -6;
      }
      break;

    default:
      return output;
  }
  
  return output;
}

// ---- Get Episode ----

export async function getEpisode(
  index: number,
  askQuality?: (options: string[]) => Promise<string>
): Promise<Anime> {
  console.log("[getEpisode] index:", index)
  showOverlay()

  const noDownload: Anime = { name: "", source: "", episodes: "", img: "", isUnread: false }
  if (index === -44) return noDownload

  const entry = loadSetting("entry", PlaceholderEntry)
  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
  const player = loadSetting(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")

  const episodeId = entry.ids[index - 1]
  console.log("[getEpisode] episodeId:", episodeId)

  const sources = await getAnimepaheSources(episodeId)
  console.log("[getEpisode] sources:", Object.keys(sources))

  const tags = Object.keys(sources)
  let selectedUrl: string | undefined

  if (autoQuality) {
    selectedUrl = qualityAutoSelect(sources, order)
    if (!selectedUrl) {
      if (!askQuality) throw new Error("askQuality callback not provided")
      const pickedTag = await askQuality(tags)
      const filtered = order.filter(q => q !== pickedTag)
      const newOrder = [
        ...filtered.slice(0, 2),
        pickedTag,
        ...filtered.slice(2)
      ]
      saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
      order = newOrder
      selectedUrl = sources[pickedTag]
    }
  } else {
    if (!askQuality) throw new Error("askQuality callback not provided")
    const pickedTag = await askQuality(tags)
    selectedUrl = sources[pickedTag]
  }

  hideOverlay()

  // selectedUrl is the direct CDN URL (MP4) or m3u8 (HLS fallback).
  // HLS needs the rust proxy for header injection; MP4 opens directly.
  const isHls = selectedUrl.includes(".m3u8")
  let openUrl: string
  if (isHls) {
    const rustProxyBase = getRustProxyUrl()
    openUrl = `${rustProxyBase}/?url=${encodeURIComponent(selectedUrl)}&origin=https://kwik.cx`
    console.log("[getEpisode] HLS fallback, proxy:", openUrl.substring(0, 80))
  } else {
    openUrl = selectedUrl
    console.log("[getEpisode] MP4:", openUrl.substring(0, 80))
  }

  const finalUrl = player === "nPlayer" ? "-" + openUrl : "://" + openUrl
  console.log("[getEpisode] opening:", (player + finalUrl).substring(0, 100))
  await Safari.openURL((player + finalUrl).toLowerCase())

  const stillUnread = index !== Number(entry.total)
  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: String(index) + "/" + entry.total,
    img: entry.img,
    isUnread: stillUnread
  }
  addCache(cacheEntry)
  return cacheEntry
}

// ---- Download Episode ----

export async function downloadEpisode(
  onProgress?: (done: number, total: number) => void,
  onStart?: (total: number) => void,
  askQuality?: (options: string[]) => Promise<string>
): Promise<[Anime, DownloadAnime]> {
  showOverlay()

  const ogEntry = loadSetting("entry", PlaceholderEntry)
  const entry = loadSetting("queueEntry", PlaceholderEntry)

  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)

  const ids = entry.ids
  const total = ids.length
  onStart?.(total)

  const safeName = sanitizeFilename(entry.name)
  const links: string[] = [`mkdir "${safeName}"`]

  let chosenTag: string | null = null

  for (let i = 0; i < total; i++) {
    const episodeId = ids[i]
    const sources = await getAnimepaheSources(episodeId)
    const tags = Object.keys(sources)

    let url = qualityAutoSelect(sources, order)

    if (!url) {
      if (autoQuality) {
        if (chosenTag) {
          url = sources[chosenTag]
        }

        if (!url) {
          if (!askQuality) throw new Error("askQuality callback not provided")
          chosenTag = await askQuality(tags)

          const filtered = order.filter(q => q !== chosenTag)
          const newOrder = [
            ...filtered.slice(0, 2),
            chosenTag,
            ...filtered.slice(2),
          ]
          saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
          order = newOrder

          url = sources[chosenTag]
        }
      } else {
        if (!askQuality) throw new Error("askQuality callback not provided")
        chosenTag = await askQuality(tags)
        url = sources[chosenTag]
      }
    }

    const number = Number(entry.episode) + i
    // If extractKwikUrl returned an HLS m3u8 (fallback), wrap with rust proxy.
    // If it returned a direct MP4 CDN URL, use it directly — no proxy needed.
    const isHls = url.includes(".m3u8")
    const dlUrl = isHls
      ? `${getRustProxyUrl()}/?url=${encodeURIComponent(url)}&origin=https://kwik.cx`
      : url
    const link = `ffmpeg -i "${dlUrl}" -c copy "~/Documents/${safeName}/${safeName} - ${number}.mp4"`
    links.push(link)

    onProgress?.(i + 1, total)
  }

  const episodeString =
    entry.episode === entry.total ? entry.episode : `${entry.episode} to ${entry.total}`

  const entryBool = ogEntry.episode != ogEntry.total

  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: `${ogEntry.episode}/${ogEntry.total}`,
    img: entry.img,
    isUnread: entryBool
  }

  const queueEntry: DownloadAnime = {
    name: entry.name,
    source: entry.id,
    episodes: episodeString,
    img: entry.img,
    links,
    isUnread: true
  }

  return [cacheEntry, queueEntry]
}

/** Queue a range of episodes for download without advancing watch progress. */
export async function queueEpisodeRange(
  info: EntryType,
  current: number,
  start: number,
  end: number,
  onProgress?: (done: number, total: number) => void,
  onStart?: (total: number) => void,
  askQuality?: (options: string[]) => Promise<string>
): Promise<[Anime, DownloadAnime] | null> {
  if (start > end) return null

  const ogEntry: EntryType = {
    ...info,
    episode: String(current),
    total: String(end),
  }
  saveSetting("entry", ogEntry)

  const queueInfo: EntryType = {
    ...info,
    episode: String(start),
    total: String(end),
    ids: info.ids.slice(start - 1, end),
  }
  saveSetting("queueEntry", queueInfo)

  return downloadEpisode(onProgress, onStart, askQuality)
}
