import { fetch } from "scripting"
import {
  paheFetchAllEpisodes,
  paheFetchAnimeDetails,
  paheFetchAnimeDetailsBySession,
  paheFetchAnimeMainPageById,
  paheSearch,
} from "./animepaheClient"
import { normalizePaheUrl } from "./animepaheSession"
import {
  allAnimeSearch,
  allAnimeGetEpisodes,
  encodeAllAnimeId,
  type AllAnimeMode,
} from "./allAnimeClient"
import { loadSetting, STORAGE_KEYS } from "./storage"

// Type definitions
type Anime = {
  name: string
  source: string
  episodes: string
  img: string
  isUnread: boolean
  paheID?: string
  ids?: { number: number; id: string; isWatched?: boolean }[]
  id?: string
  description?: string
  status?: string
}

interface BaseInfo {
  img: string
  total: string
  ids: string[]
  id: string
  episode: string
  name: string
  // Enriched from AnimePahe details page (mirrors Aniyomi animeDetailsParse)
  description?: string
  genres?: string
  status?: string
  studios?: string
}

// ===== ANIMEPAHE API =====

async function fetchAnimepaheInfo(id: string) {
  const episodes = await paheFetchAllEpisodes(id);
  return { id, episodes };
}

// ===== ANILIST DIRECT =====

const anilistGraphqlUrl = 'https://graphql.anilist.co';

// ---- Poster caching (in-memory) ----
const paheIdToExternalCover = new Map<string, string>()
const paheIdToAniListId = new Map<string, string>()
const paheIdToMalId = new Map<string, string>()
const aniListIdToCover = new Map<string, string>()
const malIdToCover = new Map<string, string>()

function anilistSearchQuery(query: string) {
  return {
    query: `
      query ($search: String) {
        Page(page: 1, perPage: 15) {
          media(search: $search, type: ANIME) {
            id
            title {
              romaji
              english
            }
            coverImage {
              large
              medium
            }
          }
        }
      }
    `,
    variables: { search: query },
  };
}

function anilistInfoQuery(id: string) {
  return {
    query: `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title {
            romaji
            english
          }
          coverImage {
            large
            medium
          }
          description
          status(version: 2)
        }
      }
    `,
    variables: { id: parseInt(id) },
  };
}

function anilistCoverQuery(id: string) {
  return {
    query: `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          coverImage {
            extraLarge
            large
            medium
          }
        }
      }
    `,
    variables: { id: parseInt(id) },
  }
}

// ===== EXPORTED FUNCTIONS =====

// Search Anilist
const searchAnilist = async (query: string): Promise<Anime[] | string> => {
  try {
    const requestData = anilistSearchQuery(query.replaceAll("/", " "));

    const response = await fetch(anilistGraphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const results = data.data.Page.media;

    const output: Anime[] = [];
    for (const item of results) {
      output.push({
        name: item.title.romaji || item.title.english,
        source: String(item.id),
        episodes: "0",
        img: item.coverImage.large || item.coverImage.medium,
        isUnread: false
      });
    }

    return output;
  } catch (error) {
    console.error("Error in searchAnilist:", error);
    throw error;
  }
}

// Search Animepahe via self-hosted animepahe-api
const searchAnimepahe = async (query: string): Promise<Anime[] | string> => {
  try {
    const results = await paheSearch(query);
    return results.map(item => ({
      name: item.title,
      source: String(item.session),
      episodes: "0",
      img: normalizePaheUrl(item.poster),
      isUnread: false,
      paheID: item.id != null ? String(item.id) : undefined,
    }));
  } catch (error) {
    console.error('[searchAnimepahe] ERROR:', error);
    throw error;
  }
}

function pickFirstMatch(html: string, patterns: RegExp[]): string | null {
  for (let i = 0; i < patterns.length; i++) {
    const m = html.match(patterns[i])
    if (m && m[1]) return m[1]
  }
  return null
}

function extractAniListIdFromPaheHtml(html: string): string | null {
  const sample = html.slice(0, 200_000)
  return pickFirstMatch(sample, [
    /<meta[^>]+name=["']anilist["'][^>]+content=["'](\d+)["'][^>]*>/i,
    /<meta[^>]+content=["'](\d+)["'][^>]+name=["']anilist["'][^>]*>/i,
  ])
}

function extractMalIdFromPaheHtml(html: string): string | null {
  const sample = html.slice(0, 200_000)
  return pickFirstMatch(sample, [
    /<meta[^>]+name=["']mal["'][^>]+content=["'](\d+)["'][^>]*>/i,
    /<meta[^>]+name=["']myanimelist["'][^>]+content=["'](\d+)["'][^>]*>/i,
    /<meta[^>]+content=["'](\d+)["'][^>]+name=["']mal["'][^>]*>/i,
    /<meta[^>]+content=["'](\d+)["'][^>]+name=["']myanimelist["'][^>]*>/i,
  ])
}

async function fetchAniListCover(anilistId: string): Promise<string | null> {
  const cached = aniListIdToCover.get(anilistId)
  if (cached) return cached
  try {
    const requestData = anilistCoverQuery(anilistId)
    const response = await fetch(anilistGraphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestData),
    })

    if (!response.ok) return null
    const data = await response.json()
    const media = data?.data?.Media
    const cover =
      media?.coverImage?.extraLarge || media?.coverImage?.large || media?.coverImage?.medium
    const url = cover ? String(cover) : null
    if (url) aniListIdToCover.set(anilistId, url)
    return url
  } catch {
    return null
  }
}

async function fetchMalCover(malId: string): Promise<string | null> {
  const cached = malIdToCover.get(malId)
  if (cached) return cached
  try {
    const response = await fetch("https://api.jikan.moe/v4/anime/" + encodeURIComponent(malId))
    if (!response.ok) return null
    const data = await response.json()
    const img =
      data?.data?.images?.jpg?.large_image_url ||
      data?.data?.images?.webp?.large_image_url ||
      data?.data?.images?.jpg?.image_url ||
      data?.data?.images?.webp?.image_url
    const url = img ? String(img) : null
    if (url) malIdToCover.set(malId, url)
    return url
  } catch {
    return null
  }
}

async function resolveExternalCoverFromPaheId(paheID: string): Promise<string | null> {
  const cachedCover = paheIdToExternalCover.get(paheID)
  if (cachedCover) return cachedCover

  const cachedAniList = paheIdToAniListId.get(paheID)
  if (cachedAniList) {
    const cover = await fetchAniListCover(cachedAniList)
    if (cover) {
      paheIdToExternalCover.set(paheID, cover)
      return cover
    }
  }

  const cachedMal = paheIdToMalId.get(paheID)
  if (cachedMal) {
    const cover = await fetchMalCover(cachedMal)
    if (cover) {
      paheIdToExternalCover.set(paheID, cover)
      return cover
    }
  }

  const html = await paheFetchAnimeMainPageById(paheID)
  const anilist = extractAniListIdFromPaheHtml(html)
  if (anilist) {
    paheIdToAniListId.set(paheID, anilist)
    const cover = await fetchAniListCover(anilist)
    if (cover) {
      paheIdToExternalCover.set(paheID, cover)
      return cover
    }
  }
  const mal = extractMalIdFromPaheHtml(html)
  if (mal) {
    paheIdToMalId.set(paheID, mal)
    const cover = await fetchMalCover(mal)
    if (cover) {
      paheIdToExternalCover.set(paheID, cover)
      return cover
    }
  }
  return null
}

async function asyncPool<T>(
  poolLimit: number,
  items: T[],
  iteratorFn: (item: T, index: number) => Promise<void>
): Promise<void> {
  const executing = new Set<Promise<void>>()
  for (let i = 0; i < items.length; i++) {
    const p = Promise.resolve()
      .then(() => iteratorFn(items[i], i))
      .catch(function () {
        /* ignore per-item */
      })
      .finally(function () {
        executing.delete(p)
      })

    executing.add(p)
    if (executing.size >= poolLimit) {
      await Promise.race(executing)
    }
  }

  await Promise.allSettled(Array.from(executing))
}

/** Replace Animepahe posters with AniList/MAL cover images (prefer AniList). */
export async function enhanceAnimepaheResultsWithExternalImages(list: Anime[]): Promise<Anime[]> {
  const out = list.slice()
  const targets = out
    .map((a, idx) => ({ a, idx }))
    .filter(x => !!x.a.paheID)

  // Limit concurrency to avoid rate limits.
  await asyncPool(6, targets, async function (t) {
    const paheID = t.a.paheID
    if (!paheID) return
    try {
      const cover = await resolveExternalCoverFromPaheId(paheID)
      if (cover) {
        out[t.idx] = { ...t.a, img: cover }
      }
    } catch {
      /* ignore per-item failures */
    }
  })

  return out
}

// Get anime info from Anilist with Animepahe episodes
const getInfoAnilist = async (anime: Anime): Promise<BaseInfo> => {
  try {
    const requestData = anilistInfoQuery(anime.source);
    const response = await fetch(anilistGraphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      console.error('[getInfoAnilist] Anilist HTTP error:', response.status);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const anilistData = await response.json();
    const media = anilistData.data.Media;
    const romajiTitle = media.title.romaji;
    const englishTitle = media.title.english;

    let episodes: any[] = [];
    let matchFound = false;

    if (romajiTitle) {
      const searchResults = await searchAnimepahe(romajiTitle);
      if (Array.isArray(searchResults) && searchResults.length > 0) {
        const match = searchResults.find(r => r.name.toLowerCase() === romajiTitle.toLowerCase()) ?? searchResults[0];
        const animepaheInfo = await fetchAnimepaheInfo(match.source);
        episodes = animepaheInfo.episodes;
        matchFound = true;
      }
    }

    if (!matchFound && englishTitle && englishTitle !== romajiTitle) {
      const searchResults = await searchAnimepahe(englishTitle);
      if (Array.isArray(searchResults) && searchResults.length > 0) {
        const match = searchResults.find(r => r.name.toLowerCase() === englishTitle.toLowerCase()) ?? searchResults[0];
        const animepaheInfo = await fetchAnimepaheInfo(match.source);
        episodes = animepaheInfo.episodes;
      }
    }

    if (episodes.length === 0) {
      console.warn('[getInfoAnilist] no episodes found for:', romajiTitle || englishTitle);
    }

    const ids = episodes.map((ep: any) => ep.id as string);
    return {
      total: String(ids.length),
      ids,
      name: media.title.romaji || media.title.english,
      id: media.id,
      episode: "none",
      img: anime.img
    };
  } catch (error) {
    console.error('[getInfoAnilist] ERROR:', error);
    throw error;
  }
}

// Get anime info from Animepahe (mirrors Aniyomi: animeDetailsParse + episodeListParse)
const getInfoAnimepahe = async (anime: Anime): Promise<BaseInfo> => {
  try {
    const search = await searchAnimepahe(anime.name)
    let match: Anime | undefined
    if (Array.isArray(search)) {
      match = search.find(obj => obj.name === anime.name) ?? search[0]
    } else {
      console.error('[getInfoAnimepahe] search failed:', search)
      throw new Error("Search failed: " + search)
    }
    if (!match) {
      console.error('[getInfoAnimepahe] no results for:', anime.name)
      throw new Error("No results found")
    }

    const session = match.source
    const paheId = match.paheID

    // Fetch episodes + full anime details in parallel (1:1 Aniyomi efficiency)
    const [animepaheInfo, details] = await Promise.all([
      fetchAnimepaheInfo(session),
      (async () => {
        try {
          if (paheId) return await paheFetchAnimeDetails(paheId)
          return await paheFetchAnimeDetailsBySession(session)
        } catch {
          return null
        }
      })(),
    ])

    const ids = animepaheInfo.episodes.map((ep: any) => ep.id as string)

    // Use full-res thumbnail from details page if available, else keep the search poster
    const img = details?.thumbnail || anime.img

    return {
      total: String(ids.length),
      ids,
      name: match.name,
      id: animepaheInfo.id,
      episode: "none",
      img,
      description: details?.description,
      genres: details?.genres,
      status: details?.status,
      studios: details?.studios,
    }
  } catch (error) {
    console.error('[getInfoAnimepahe] ERROR:', error)
    throw error
  }
}

// ===== ALLANIME SOURCE =====

/** Returns the user's preferred AllAnime mode ("sub" | "dub"). */
function getAllAnimeMode(): AllAnimeMode {
  return loadSetting<string>(STORAGE_KEYS.ALLANIME_MODE, "sub") === "dub" ? "dub" : "sub"
}

export const searchAllAnime = async (query: string): Promise<Anime[]> => {
  const mode = getAllAnimeMode()
  const results = await allAnimeSearch(query, mode)
  return results.map(r => ({
    name:      r.title,
    source:    `allanime:${r.id}`,   // prefix so Cache can distinguish
    episodes:  String(r.episodeCount),
    img:       r.img,
    isUnread:  false,
  }))
}

export const getInfoAllAnime = async (anime: Anime): Promise<BaseInfo> => {
  // source is "allanime:{showId}"
  const showId = anime.source.startsWith("allanime:")
    ? anime.source.slice("allanime:".length)
    : anime.source

  const mode = getAllAnimeMode()
  const epNums = await allAnimeGetEpisodes(showId, mode)

  const ids = epNums.map(n => encodeAllAnimeId(showId, n, mode))

  return {
    total:   String(ids.length),
    ids,
    name:    anime.name,
    id:      showId,
    episode: "none",
    img:     anime.img,
  }
}

export {
  searchAnilist,
  getInfoAnilist,
  searchAnimepahe,
  getInfoAnimepahe,
  type BaseInfo,
}
