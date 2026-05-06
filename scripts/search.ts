import { fetch } from "scripting"

// Type definitions
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

interface BaseInfo {
  img: string
  total: string
  ids: string[]
  id: string
  episode: string
  name: string
}

// ===== ANIMEPAHE DIRECT =====

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

async function fetchEpisodes(session: string, page: number) {
  console.log(`[fetchEpisodes] Fetching session: ${session}, page: ${page}`);
  const response = await fetch(
    `${baseUrl}/api?m=release&id=${session}&sort=episode_asc&page=${page}`,
    { headers: getHeaders(session) }
  );

  if (!response.ok) {
    console.error('[fetchEpisodes] HTTP error:', response.status);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  console.log('[fetchEpisodes] Parsing JSON');
  const data = await response.json();
  console.log('[fetchEpisodes] Got', data.data?.length || 0, 'episodes');

  return {
    episodes: data.data.map((item: any) => ({
      id: `${session}/${item.session}`,
      number: item.episode,
    })),
    lastPage: data.last_page,
  };
}

async function fetchAnimepaheInfo(id: string) {
  console.log('[fetchAnimepaheInfo] START - id:', id);
  console.log('[fetchAnimepaheInfo] Fetching page 1');
  const firstPage = await fetchEpisodes(id, 1);
  console.log('[fetchAnimepaheInfo] Got', firstPage.episodes.length, 'episodes from page 1, total pages:', firstPage.lastPage);
  const allEpisodes = [...firstPage.episodes];

  for (let page = 2; page <= firstPage.lastPage; page++) {
    console.log(`[fetchAnimepaheInfo] Fetching page ${page}/${firstPage.lastPage}`);
    const pageData = await fetchEpisodes(id, page);
    allEpisodes.push(...pageData.episodes);
  }

  console.log('[fetchAnimepaheInfo] DONE - total episodes:', allEpisodes.length);
  return {
    id,
    episodes: allEpisodes,
  };
}

// ===== ANILIST DIRECT =====

const anilistGraphqlUrl = 'https://graphql.anilist.co';

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

// Search Animepahe directly
const searchAnimepahe = async (query: string): Promise<Anime[] | string> => {
  console.log('[searchAnimepahe] START - query:', query);
  try {
    const cleanQuery = query.replaceAll(/[^\p{L}\p{N}\s]/gu, "");
    console.log('[searchAnimepahe] Clean query:', cleanQuery);
    console.log('[searchAnimepahe] Fetching search results');
    const response = await fetch(
      `${baseUrl}/api?m=search&q=${encodeURIComponent(cleanQuery)}`,
      { headers: getHeaders() }
    );

    if (!response.ok) {
      console.error('[searchAnimepahe] HTTP error:', response.status);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log('[searchAnimepahe] Parsing JSON');
    const data = await response.json();
    console.log('[searchAnimepahe] Got', data.data?.length || 0, 'results');
    
    const output: Anime[] = [];
    for (const item of data.data) {
      output.push({
        name: item.title,
        source: String(item.session),
        episodes: "0",
        img: item.poster,
        isUnread: false
      });
    }

    console.log('[searchAnimepahe] DONE - returning', output.length, 'results');
    return output;
  } catch (error) {
    console.error('[searchAnimepahe] ERROR:', error);
    throw error;
  }
}

// Get anime info from Anilist with Animepahe episodes
const getInfoAnilist = async (anime: Anime): Promise<BaseInfo> => {
  console.log('[getInfoAnilist] START - anime:', anime.name, 'source:', anime.source);
  try {
    const requestData = anilistInfoQuery(anime.source);
    console.log('[getInfoAnilist] Fetching Anilist data');

    const response = await fetch(anilistGraphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      console.error('[getInfoAnilist] Anilist HTTP error:', response.status);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log('[getInfoAnilist] Parsing Anilist data');
    const anilistData = await response.json();
    const media = anilistData.data.Media;
    console.log('[getInfoAnilist] Got media:', media.title.romaji || media.title.english);

    // Get episodes from Animepahe
    const title = media.title.romaji || media.title.english;
    console.log('[getInfoAnilist] Searching Animepahe for:', title);
    const searchResults = await searchAnimepahe(title);
    console.log('[getInfoAnilist] Animepahe search returned', Array.isArray(searchResults) ? searchResults.length : 0, 'results');
    
    let episodes: any[] = [];
    if (Array.isArray(searchResults) && searchResults.length > 0) {
      console.log('[getInfoAnilist] Fetching Animepahe info for:', searchResults[0].source);
      const animepaheInfo = await fetchAnimepaheInfo(searchResults[0].source);
      episodes = animepaheInfo.episodes;
      console.log('[getInfoAnilist] Got', episodes.length, 'episodes from Animepahe');
    }

    const ids: string[] = [];
    for (const ep of episodes) {
      ids.push(ep.id);
    }
    console.log('[getInfoAnilist] Mapped', ids.length, 'episode IDs');

    const output: BaseInfo = {
      total: String(ids.length),
      ids: ids,
      name: media.title.romaji || media.title.english,
      id: media.id,
      episode: "none",
      img: anime.img
    };

    console.log('[getInfoAnilist] DONE - returning output:', output);
    return output;
  } catch (error) {
    console.error('[getInfoAnilist] ERROR:', error);
    throw error;
  }
}

// Get anime info from Animepahe
const getInfoAnimepahe = async (anime: Anime): Promise<BaseInfo> => {
  console.log('[getInfoAnimepahe] START - anime:', anime.name);
  try {
    console.log('[getInfoAnimepahe] Searching Animepahe');
    const search = await searchAnimepahe(anime.name);
    console.log('[getInfoAnimepahe] Search returned', Array.isArray(search) ? search.length : 0, 'results');
    
    let match: Anime | undefined;
    if (Array.isArray(search)) {
      match = search.find(obj => obj.name === anime.name);
      if (match) {
        console.log('[getInfoAnimepahe] Got exact match:', match.name);
      } else {
        console.log('[getInfoAnimepahe] No exact match, using first result');
        match = search[0];
      }
    } else {
      console.error('[getInfoAnimepahe] Search failed:', search);
      throw new Error("Search failed: " + search);
    }

    if (!match) {
      console.error('[getInfoAnimepahe] No results found');
      throw new Error("No results found");
    }

    console.log('[getInfoAnimepahe] Fetching info for source:', match.source);
    const animepaheInfo = await fetchAnimepaheInfo(match.source);
    console.log('[getInfoAnimepahe] Got', animepaheInfo.episodes.length, 'episodes');

    const ids: string[] = [];
    for (const ep of animepaheInfo.episodes) {
      ids.push(ep.id);
    }
    console.log('[getInfoAnimepahe] Mapped', ids.length, 'episode IDs');

    const output: BaseInfo = {
      total: String(ids.length),
      ids: ids,
      name: match.name,
      id: animepaheInfo.id,
      episode: "none",
      img: anime.img
    };

    console.log('[getInfoAnimepahe] DONE - returning output:', output);
    return output;
  } catch (error) {
    console.error('[getInfoAnimepahe] ERROR:', error);
    throw error;
  }
}

export {
  searchAnilist,
  getInfoAnilist,
  searchAnimepahe,
  getInfoAnimepahe,
  type BaseInfo
}
