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
  paheHeaders,
} from "./animepaheClient"

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

async function extractKwikUrl(kwikUrl: string): Promise<string> {
  const response = await fetch(kwikUrl, {
    headers: paheHeaders({ referer: getDirectBaseUrl() + "/", mode: "navigate" }),
  })

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }

  const html = await response.text()
  const packedMatch = /(eval)(\(f.*?)(\n<\/script>)/s.exec(html)
  if (!packedMatch) throw new Error("Could not find packed script")

  const unpacked = eval(packedMatch[2].replace("eval", ""))
  const m3u8Match = unpacked.match(/https.*?m3u8/)
  if (!m3u8Match) throw new Error("Could not find m3u8 URL")

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

function parseResolutionMenu(html: string) {
  const buttons: { url: string; quality: string }[] = []
  const buttonRegex = /<button[^>]*class="dropdown-item[^"]*"[^>]*>(.*?)<\/button>/gs

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

    buttons.push({ url: srcMatch[1], quality })
  }

  return buttons
}

async function scrapePlayPageSources(episodeId: string): Promise<QualityMap> {
  const html = await directFetchPlayPage(episodeId)
  const buttons = parseResolutionMenu(html)
  const dict: QualityMap = {}

  for (const button of buttons) {
    try {
      const url = await extractKwikUrl(button.url)
      const parts = button.quality.split(" · ")
      const tag = "-" + (parts[1] ?? parts[0]).trim()
      if (!tag.endsWith("eng")) dict[tag] = url
    } catch (err) {
      console.error(`[getAnimepaheSources] Failed quality ${button.quality}:`, err)
    }
  }

  return dict
}

export async function getAnimepaheSources(episodeId: string): Promise<QualityMap> {
  console.log("[getAnimepaheSources] Fetching:", episodeId)

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
  console.log("[getEpisode] START - index:", index);
  showOverlay()
  console.log("[getEpisode] Overlay shown");

  const noDownload: Anime = { name: "", source: "", episodes: "", img: "", isUnread: false }
  if (index === -44) {
    console.log("[getEpisode] No download, returning early");
    return noDownload;
  }

  console.log("[getEpisode] Loading settings");
  const entry = loadSetting("entry", PlaceholderEntry)
  console.log("[getEpisode] Entry loaded:", entry);
  
  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  console.log("[getEpisode] Auto quality:", autoQuality);
  
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
  console.log("[getEpisode] Quality order:", order);
  
  const player = loadSetting(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")
  console.log("[getEpisode] Player:", player);

  const episodeId = entry.ids[index - 1]
  console.log("[getEpisode] Episode ID:", episodeId);
  console.log("[getEpisode] Calling getAnimepaheSources...");
  
  const sources = await getAnimepaheSources(episodeId)
  console.log("[getEpisode] Sources received:", sources);
  
  const tags = Object.keys(sources)
  console.log("[getEpisode] Available tags:", tags);




  let selectedUrl: string | undefined
  console.log("[getEpisode] Selecting quality...");

  if (autoQuality) {
    console.log(order)
    console.log("[getEpisode] Auto quality mode");
    selectedUrl = qualityAutoSelect(sources, order)
    console.log("[getEpisode] Auto selected:", selectedUrl);
    
    if (!selectedUrl) {
      console.log("[getEpisode] No auto match, asking user");
      if (!askQuality) throw new Error("askQuality callback not provided")
      const pickedTag = await askQuality(tags)
      console.log("[getEpisode] User picked:", pickedTag);

      const filtered = order.filter(q => q !== pickedTag)
      const newOrder = [
        ...filtered.slice(0, 2),
        pickedTag,
        ...filtered.slice(2)
      ]

      saveSetting(STORAGE_KEYS.QUALITY_ORDER, newOrder)
      console.log("[getEpisode] Updated quality order");
      order = newOrder

      selectedUrl = sources[pickedTag]
      console.log("[getEpisode] Selected URL:", selectedUrl);
    }
  } else {
    console.log("[getEpisode] Manual quality mode");
    if (!askQuality) throw new Error("askQuality callback not provided")
    const pickedTag = await askQuality(tags)
    console.log("[getEpisode] User picked:", pickedTag);
    selectedUrl = sources[pickedTag]
    console.log("[getEpisode] Selected URL:", selectedUrl);
  }

  console.log("[getEpisode] Hiding overlay");
  hideOverlay()

  const rustProxyBase = getRustProxyUrl()
  const proxyUrl = `${rustProxyBase}/?url=${encodeURIComponent(selectedUrl)}&origin=https://kwik.cx`
  const finalUrl = player === "nPlayer" ? "-" + proxyUrl : "://" + proxyUrl
  console.log("[getEpisode] Proxy URL:", proxyUrl);
  console.log("[getEpisode] Final URL:", (player + finalUrl).toLowerCase());
  console.log("[getEpisode] Opening in Safari...");
  await Safari.openURL((player + finalUrl).toLowerCase())
  console.log("[getEpisode] Safari opened");

  const stillUnread = index !== Number(entry.total)
  console.log("[getEpisode] Still unread:", stillUnread);
  
  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: String(index) + "/" + entry.total,
    img: entry.img,
    isUnread: stillUnread
  }
  console.log("[getEpisode] Cache entry created:", cacheEntry);

  console.log("[getEpisode] Adding to cache");
  addCache(cacheEntry)
  console.log("[getEpisode] DONE");
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

    // url is already the HLS m3u8 URL, wrap it with proxy
    // Encode URL parameter for the proxy (this is required for the proxy to work)
    const rustProxyBase = getRustProxyUrl()
    const proxyUrl = `${rustProxyBase}/?url=${encodeURIComponent(url)}&origin=https://kwik.cx`
    const number = Number(entry.episode) + i
    const link = `ffmpeg -i "${proxyUrl}" -c copy "~/Documents/${safeName}/${safeName} - ${number}.mp4"`
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
