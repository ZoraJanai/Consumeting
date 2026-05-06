// Episode handling with direct Animepahe scraping
import { fetch, useState } from "scripting"
import { loadSetting, saveSetting } from "../Pages/Settings"
import { hideOverlay, showOverlay } from "../Pages/Loading"
import { addCache, addQueue } from "./cache"
import { saveData } from "./data"
import { BaseInfo } from "./search"

// ---- Types ----

type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
  ids?: { number: number; id: string; isWatched?: boolean }[]
  id?: string
  description?: string
  status?: string
}

export type QualityMap = Record<string, string>

type EntryType = {
  name: string
  ids: { number: number; id: string; isWatched?: boolean }[]
  episode: string
  total: string
  id: string
  description?: string
  status?: string
  img: string
}

export type DownloadAnime = {
  name: string
  source: string
  episodes: string
  img: string
  links: string[]
  isUnread: boolean
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

export const STORAGE_KEYS = {
  VIDEO_PLAYER: "settings.videoPlayer",
  AUTO_QUALITY: "settings.autoQuality",
  QUALITY_ORDER: "settings.qualityOrder"
}

// ---- Direct Animepahe Source Fetching ----

const baseUrl = 'https://animepahe.pw';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function getHeaders(sessionId?: string) {
  return {
    authority: 'animepahe.pw',
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    cookie: '__ddg2_=;',
    dnt: '1',
    'sec-ch-ua': '"Not A(Brand";v="99", "Microsoft Edge";v="121", "Chromium";v="121"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-requested-with': 'XMLHttpRequest',
    referer: sessionId ? `${baseUrl}/anime/${sessionId}` : `${baseUrl}`,
    'user-agent': USER_AGENT,
  };
}

async function extractKwikUrl(kwikUrl: string): Promise<string> {
  const response = await fetch(kwikUrl, {
    headers: { Referer: 'https://animepahe.pw/' },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const html = await response.text();
  const packedMatch = /(eval)(\(f.*?)(\n<\/script>)/s.exec(html);
  if (!packedMatch) {
    throw new Error('Could not find packed script');
  }

  const unpacked = eval(packedMatch[2].replace('eval', ''));
  const m3u8Match = unpacked.match(/https.*?m3u8/);
  if (!m3u8Match) {
    throw new Error('Could not find m3u8 URL');
  }

  return m3u8Match[0];
}

function parseResolutionMenu(html: string) {
  const buttons: { url: string; quality: string; audio?: string }[] = [];
  const buttonRegex = /<button[^>]*data-src="([^"]*)"[^>]*>([^<]*)<\/button>/g;
  let match;
  
  while ((match = buttonRegex.exec(html)) !== null) {
    const dataSrc = match[1];
    const quality = match[2].trim();
    const audioMatch = new RegExp(`data-src="${dataSrc}"[^>]*data-audio="([^"]*)"`, 'g').exec(html);
    
    buttons.push({
      url: dataSrc,
      quality: quality,
      audio: audioMatch ? audioMatch[1] : undefined,
    });
  }
  
  return buttons;
}

export async function getAnimepaheSources(episodeId: string): Promise<QualityMap> {
  const response = await fetch(
    `${baseUrl}/play/${episodeId}`,
    { headers: getHeaders(episodeId.split('/')[0]) }
  );

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const html = await response.text();
  const buttons = parseResolutionMenu(html);

  const dict: QualityMap = {};
  
  for (const button of buttons) {
    const url = await extractKwikUrl(button.url);
    const parts = button.quality.split(" · ");
    const tag = "-" + (parts[1] ?? parts[0]).trim();
    
    // Skip "eng" suffix
    if (!tag.endsWith("eng")) {
      dict[tag] = url;
    }
  }

  console.log(dict);
  return dict;
  
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
  showOverlay()

  const noDownload: Anime = { name: "", source: "", episodes: "", img: "", isUnread: false }
  if (index === -44) return noDownload

  const entry = loadSetting("entry", PlaceholderEntry)
  const autoQuality = loadSetting(STORAGE_KEYS.AUTO_QUALITY, true)
  let order = loadSetting(STORAGE_KEYS.QUALITY_ORDER, QualitiesOrder)
  const player = loadSetting(STORAGE_KEYS.VIDEO_PLAYER, "nPlayer")

  const episodeId = entry.ids[index - 1]?.id || entry.ids[index - 1]
  const sources = await getAnimepaheSources(episodeId)
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

  // selectedUrl is already the HLS m3u8 URL (no kwikExtractor needed)
  hideOverlay()

  const finalUrl = player === "nPlayer" ? "-" + selectedUrl : selectedUrl.replace("https", "")
  await Safari.openURL((player + finalUrl).toLowerCase())

  const stillUnread = index !== Number(entry.total)
  
  const updatedIds = entry.ids ? entry.ids.map(ep => 
    ep.number === index ? { ...ep, isWatched: true } : ep
  ) : undefined
  
  const updatedEntry = { ...entry, ids: updatedIds }
  saveSetting("entry", updatedEntry)
  
  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: String(index) + "/" + entry.total,
    img: entry.img,
    isUnread: stillUnread,
    ids: updatedIds,
    id: entry.id,
    description: entry.description,
    status: entry.status
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

  const links: string[] = [`mkdir ${entry.name.replaceAll(" ", "\\ ")}`]

  let chosenTag: string | null = null

  for (let i = 0; i < total; i++) {
    const episodeId = ids[i]?.id || ids[i]
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

    // url is already the HLS m3u8 URL
    const number = Number(entry.episode) + i
    const link = `ffmpeg -i "${url}" -c copy ~/Documents/${entry.name.replaceAll(" ", "\\ ")}/${entry.name.replaceAll(" ", "\\ ")}\\ -\\ ${number}.mp4`
    links.push(link)

    onProgress?.(i + 1, total)
  }

  const episodeString =
    entry.episode === entry.total ? entry.episode : `${entry.episode} to ${entry.total}`

  const entryBool = ogEntry.episode != ogEntry.total
  
  const startEpisode = Number(entry.episode)
  const updatedIds = ogEntry.ids ? ogEntry.ids.map(ep => {
    const episodeNumber = ep.number
    if (episodeNumber >= startEpisode && episodeNumber <= Number(entry.total)) {
      return { ...ep, isWatched: true }
    }
    return ep
  }) : undefined

  const cacheEntry: Anime = {
    name: entry.name,
    source: entry.id,
    episodes: `${ogEntry.episode}/${ogEntry.total}`,
    img: entry.img,
    isUnread: entryBool,
    ids: updatedIds,
    id: entry.id,
    description: entry.description,
    status: entry.status
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
