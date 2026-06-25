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
import {
  captureKwikCookies,
  getStoredKwikCookies,
  isWebViewSessionActive,
  paheHeaders,
} from "./animepaheSession"

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


function useApiMode(): boolean {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").trim().length > 0
}

// ─── HLS extractor — mirrors Aniyomi getHlsVideo (kwik.cx/e/xxx embed) ──────
//
// HAR analysis: Aniyomi hits kwik.cx/e/xxx with:
//   Referer: https://animepahe.pw/
//   Cookie: srv=s0; kwik_session=xxx  (no cf_clearance — /e/ is not CF-protected)
//
// kwik_session is obtained during boot captureKwikCookies() and reused here.
// On failure the session is refreshed once before giving up.
async function extractKwikHlsUrl(kwikEmbedUrl: string, animepaheBase: string): Promise<string> {
  const buildHeaders = () => {
    const h = paheHeaders({ referer: animepaheBase + "/", mode: "navigate" })
    const { cookies, userAgent } = getStoredKwikCookies()
    if (cookies) h["Cookie"] = cookies
    if (userAgent) h["User-Agent"] = userAgent
    return h
  }

  if (!getStoredKwikCookies().cookies && isWebViewSessionActive()) {
    console.log("[kwikHls] no saved kwik cookies — capturing session first")
    await captureKwikCookies()
  }

  let response = await fetch(kwikEmbedUrl, { headers: buildHeaders() })

  if (!response.ok && isWebViewSessionActive()) {
    console.log("[kwikHls] status", response.status, "— refreshing kwik session")
    await captureKwikCookies()
    response = await fetch(kwikEmbedUrl, { headers: buildHeaders() })
  }

  if (!response.ok) throw new Error(`[kwikHls] fetch failed: ${response.status}`)

  const html = await response.text()
  const packedMatch = /(eval)(\(f.*?)(\n<\/script>)/s.exec(html)
  if (!packedMatch) throw new Error("[kwikHls] packed script not found")

  const unpacked = eval(packedMatch[2].replace("eval", ""))
  const m3u8Match = unpacked.match(/https.*?m3u8/)
  if (!m3u8Match) throw new Error("[kwikHls] m3u8 URL not found")

  console.log("[kwikHls] m3u8:", m3u8Match[0].slice(0, 100))
  return m3u8Match[0]
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

// Parse div#resolutionMenu buttons — extract kwikUrl (data-src) and quality label.
// Skips English-audio variants (data-audio="eng") exactly as Aniyomi does.
function parseResolutionMenu(html: string): { kwikUrl: string; quality: string }[] {
  const result: { kwikUrl: string; quality: string }[] = []
  const buttonRegex = /<button[^>]*class="dropdown-item[^"]*"[^>]*>([\s\S]*?)<\/button>/g
  let match

  while ((match = buttonRegex.exec(html)) !== null) {
    const fullButton = match[0]
    const innerText = match[1]
    const srcMatch = /data-src="([^"]*)"/.exec(fullButton)
    if (!srcMatch) continue

    const audioMatch = /data-audio="([^"]*)"/.exec(fullButton)
    if (audioMatch?.[1]?.toLowerCase() === "eng") continue

    const textMatch = /^\s*(.*?)\s*(?:<span|$)/.exec(innerText)
    const quality = decodeHtmlEntities(textMatch ? textMatch[1].trim() : innerText.trim())
    result.push({ kwikUrl: srcMatch[1], quality })
  }

  return result
}

async function scrapePlayPageSources(episodeId: string, qualityOrder?: string[]): Promise<QualityMap> {
  const html = await directFetchPlayPage(episodeId)
  const entries = parseResolutionMenu(html)
  const base = getDirectBaseUrl()

  // Build tag → kwikUrl map without hitting kwik yet
  const kwikMap: Record<string, string> = {}
  for (const entry of entries) {
    const parts = entry.quality.split(" · ")
    const tag = "-" + (parts[1] ?? parts[0]).trim()
    kwikMap[tag] = entry.kwikUrl
  }

  const tags = Object.keys(kwikMap)

  // Pick which tag to extract — use quality order if provided, else fetch all
  let tagsToFetch: string[]
  if (qualityOrder && qualityOrder.length > 0) {
    const chosen = qualityOrder.find(q => kwikMap[q]) ?? tags[0]
    tagsToFetch = chosen ? [chosen] : tags
    console.log("[getAnimepaheSources] pre-selected quality:", tagsToFetch[0])
  } else {
    tagsToFetch = tags
  }

  const dict: QualityMap = {}
  for (const tag of tagsToFetch) {
    try {
      dict[tag] = await extractKwikHlsUrl(kwikMap[tag], base)
    } catch (err) {
      console.error(`[getAnimepaheSources] Failed quality ${tag}:`, err)
    }
  }

  return dict
}

export async function getAnimepaheSources(episodeId: string, qualityOrder?: string[]): Promise<QualityMap> {
  if (useApiMode()) {
    return paheFetchStreamingSourcesFromApi(episodeId)
  }

  return scrapePlayPageSources(episodeId, qualityOrder)
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

  const sources = await getAnimepaheSources(episodeId, autoQuality ? order : undefined)
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

  const openUrl = selectedUrl
  console.log("[getEpisode] m3u8:", openUrl.substring(0, 100))

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
  // Escape all shell-special chars; alphanumerics, dash, dot, underscore, colon, equals, @ are safe unquoted
  const escapedName = safeName.replace(/([^a-zA-Z0-9.\-_:=@])/g, '\\$1')
  const links: string[] = [`mkdir "${safeName}"`]

  // Phase 1: fetch all episode sources in parallel (3 workers, 125ms global gap)
  const allSources: QualityMap[] = new Array(total)
  let fetchDone = 0
  let cursor = 0
  let lastFetch = 0   // timestamp of last request start (ms)

  const gatedFetch = async (episodeId: string): Promise<QualityMap> => {
    const now = Date.now()
    const wait = lastFetch + 1800 - now
    if (wait > 0) await new Promise<void>(r => setTimeout(r, wait))
    lastFetch = Date.now()
    return getAnimepaheSources(episodeId, autoQuality ? order : undefined)
  }

  await Promise.all(
    Array.from({ length: Math.min(1, total) }, async () => {
      while (true) {
        const i = cursor++
        if (i >= total) break
        allSources[i] = await gatedFetch(ids[i])
        fetchDone++
        onProgress?.(fetchDone, total)
      }
    })
  )

  // Phase 2: build links in order (quality selection is single-prompt, reused across episodes)
  let chosenTag: string | null = null

  for (let i = 0; i < total; i++) {
    const sources = allSources[i]
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
          const newOrder = [...filtered.slice(0, 2), chosenTag, ...filtered.slice(2)]
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
    links.push(`python3 hls_fix.py "${url}"`)
    links.push(`ffmpeg -allowed_extensions ALL -i hls_fixed/local.m3u8 -c copy ~/Documents/${escapedName}/${escapedName}\\ -\\ ${number}.mp4`)
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
