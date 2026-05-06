// Episode handling with direct Animepahe scraping
import { fetch, useState } from "scripting"
import { loadSetting, saveSetting, STORAGE_KEYS } from "../Pages/Settings"
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

// ---- Direct Animepahe Source Fetching ----

function getBaseUrl(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, 'https://animepahe.pw')
}

function getRustProxyUrl(): string {
  return loadSetting(STORAGE_KEYS.RUST_PROXY_URL, 'https://rust-proxy-hvm4.onrender.com')
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function getHeaders(sessionId?: string) {
  const baseUrl = getBaseUrl()
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
  console.log('[extractKwikUrl] Fetching:', kwikUrl);
  
  const response = await fetch(kwikUrl, {
    headers: { Referer: 'https://animepahe.pw/' },
  });

  if (!response.ok) {
    console.error('[extractKwikUrl] HTTP error:', response.status);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  console.log('[extractKwikUrl] Got response, parsing HTML');
  const html = await response.text();
  console.log('[extractKwikUrl] HTML length:', html.length);
  
  const packedMatch = /(eval)(\(f.*?)(\n<\/script>)/s.exec(html);
  if (!packedMatch) {
    console.error('[extractKwikUrl] Could not find packed script in HTML');
    throw new Error('Could not find packed script');
  }

  console.log('[extractKwikUrl] Found packed script, unpacking...');
  try {
    const unpacked = eval(packedMatch[2].replace('eval', ''));
    console.log('[extractKwikUrl] Unpacked, searching for m3u8');
    
    const m3u8Match = unpacked.match(/https.*?m3u8/);
    if (!m3u8Match) {
      console.error('[extractKwikUrl] Could not find m3u8 in unpacked:', unpacked.substring(0, 200));
      throw new Error('Could not find m3u8 URL');
    }

    console.log('[extractKwikUrl] Found m3u8:', m3u8Match[0]);
    return m3u8Match[0];
  } catch (err) {
    console.error('[extractKwikUrl] eval() failed:', err);
    throw new Error('Failed to unpack Kwik script: ' + err);
  }
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&middot;': '·',
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  
  return text.replace(/&[a-z0-9#]+;/gi, (entity) => entities[entity] || entity);
}

function parseResolutionMenu(html: string) {
  console.log('[parseResolutionMenu] START - HTML length:', html.length);
  const buttons: { url: string; quality: string; audio?: string }[] = [];
  const buttonRegex = /<button[^>]*data-src="([^"]*)"[^>]*>([^<]*)<\/button>/g;
  console.log('[parseResolutionMenu] Regex created, starting search');

  let match;
  let count = 0;

  while ((match = buttonRegex.exec(html)) !== null) {
    count++;
    const dataSrc = match[1];
    const rawQuality = match[2].trim();
    const quality = decodeHtmlEntities(rawQuality);
    console.log(`[parseResolutionMenu] Found button ${count}: quality="${quality}" (raw: "${rawQuality}"), url="${dataSrc}"`);

    const audioMatch = new RegExp(`data-src="${dataSrc}"[^>]*data-audio="([^"]*)"`, 'g').exec(html);
    const audio = audioMatch ? audioMatch[1] : undefined;
    console.log(`[parseResolutionMenu] Audio track: ${audio}`);

    buttons.push({
      url: dataSrc,
      quality: quality,
      audio: audio,
    });
  }

  console.log('[parseResolutionMenu] DONE - Found', buttons.length, 'buttons');
  return buttons;
}

export async function getAnimepaheSources(episodeId: string): Promise<QualityMap> {
  console.log('[getAnimepaheSources] Fetching episode page:', episodeId);
  const baseUrl = getBaseUrl()
  
  const response = await fetch(
    `${baseUrl}/play/${episodeId}`,
    { headers: getHeaders(episodeId.split('/')[0]) }
  );

  if (!response.ok) {
    console.error('[getAnimepaheSources] HTTP error:', response.status);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  console.log('[getAnimepaheSources] Parsing resolution menu');
  const html = await response.text();
  const buttons = parseResolutionMenu(html);
  console.log('[getAnimepaheSources] Found', buttons.length, 'quality options');

  const dict: QualityMap = {};
  
  for (let i = 0; i < buttons.length; i++) {
    const button = buttons[i];
    console.log(`[getAnimepaheSources] Processing quality ${i+1}/${buttons.length}: ${button.quality}`);
    
    try {
      const url = await extractKwikUrl(button.url);
      const parts = button.quality.split(" · ");
      const tag = "-" + (parts[1] ?? parts[0]).trim();
      
      // Skip "eng" suffix
      if (!tag.endsWith("eng")) {
        dict[tag] = url;
        console.log(`[getAnimepaheSources] Added ${tag}`);
      }
    } catch (err) {
      console.error(`[getAnimepaheSources] Failed to extract quality ${button.quality}:`, err);
      // Continue with other qualities instead of failing completely
    }
  }

  console.log('[getAnimepaheSources] Final dict:', dict);
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

  const links: string[] = [`mkdir "${entry.name}"`]

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
    const rustProxyBase = getRustProxyUrl()
    const proxyUrl = `${rustProxyBase}/?url=${encodeURIComponent(url)}&origin=https://kwik.cx`
    const number = Number(entry.episode) + i
    const link = `ffmpeg -i "${proxyUrl}" -c copy "~/Documents/${entry.name}/${entry.name} - ${number}.mp4"`
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
