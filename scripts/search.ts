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
  ids: { number: number; id: string; isWatched?: boolean }[]
  id: string
  episode: string
  name: string
  description?: string
  status?: string
}

// ===== ANIMEPAHE DIRECT =====

const baseUrl = 'https://animepahe.ru';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function getHeaders(sessionId?: string) {
  return {
    authority: 'animepahe.ru',
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
  const response = await fetch(
    `${baseUrl}/api?m=release&id=${session}&sort=episode_asc&page=${page}`,
    { headers: getHeaders(session) }
  );

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();

  return {
    episodes: data.data.map((item: any) => ({
      id: `${session}/${item.session}`,
      number: item.episode,
    })),
    lastPage: data.last_page,
  };
}

async function fetchAnimepaheInfo(id: string) {
  const firstPage = await fetchEpisodes(id, 1);
  const allEpisodes = [...firstPage.episodes];

  for (let page = 2; page <= firstPage.lastPage; page++) {
    const pageData = await fetchEpisodes(id, page);
    allEpisodes.push(...pageData.episodes);
  }

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
  try {
    const cleanQuery = query.replaceAll(/[^\p{L}\p{N}\s]/gu, "");
    const response = await fetch(
      `${baseUrl}/api?m=search&q=${encodeURIComponent(cleanQuery)}`,
      { headers: getHeaders() }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
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

    return output;
  } catch (error) {
    console.error("Error in searchAnimepahe:", error);
    throw error;
  }
}

// Get anime info from Anilist with Animepahe episodes
const getInfoAnilist = async (anime: Anime): Promise<BaseInfo> => {
  try {
    const requestData = anilistInfoQuery(anime.source);

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

    const anilistData = await response.json();
    const media = anilistData.data.Media;

    // Get episodes from Animepahe
    const title = media.title.romaji || media.title.english;
    const searchResults = await searchAnimepahe(title);
    
    let episodes: any[] = [];
    if (Array.isArray(searchResults) && searchResults.length > 0) {
      const animepaheInfo = await fetchAnimepaheInfo(searchResults[0].source);
      episodes = animepaheInfo.episodes;
    }

    const ids: { number: number; id: string; isWatched?: boolean }[] = [];
    for (const ep of episodes) {
      ids.push({
        number: ep.number,
        id: ep.id,
        isWatched: false
      });
    }

    const output: BaseInfo = {
      total: String(ids.length),
      ids: ids,
      name: media.title.romaji || media.title.english,
      id: media.id,
      episode: "none",
      img: anime.img,
      description: media.description || undefined,
      status: media.status || undefined
    };

    console.log(output);
    return output;
  } catch (error) {
    console.error("Error in getInfoAnilist:", error);
    throw error;
  }
}

// Get anime info from Animepahe
const getInfoAnimepahe = async (anime: Anime): Promise<BaseInfo> => {
  console.log(anime.name);
  try {
    const search = await searchAnimepahe(anime.name);
    
    let match: Anime | undefined;
    if (Array.isArray(search)) {
      match = search.find(obj => obj.name === anime.name);
      if (match) {
        console.log("Got exact match:", match);
      } else {
        console.log("No exact match, using first result");
        match = search[0];
      }
    } else {
      throw new Error("Search failed: " + search);
    }

    if (!match) {
      throw new Error("No results found");
    }

    const animepaheInfo = await fetchAnimepaheInfo(match.source);

    const ids: { number: number; id: string; isWatched?: boolean }[] = [];
    for (const ep of animepaheInfo.episodes) {
      ids.push({
        number: ep.number,
        id: ep.id,
        isWatched: false
      });
    }

    const output: BaseInfo = {
      total: String(ids.length),
      ids: ids,
      name: match.name,
      id: animepaheInfo.id,
      episode: "none",
      img: anime.img,
      description: undefined,
      status: undefined
    };

    return output;
  } catch (error) {
    console.error("Error in getInfoAnimepahe:", error);
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
