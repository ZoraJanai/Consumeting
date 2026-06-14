import { fetch } from "scripting"
import { paheFetchAllEpisodes, paheSearch } from "./animepaheClient"

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

// ===== ANIMEPAHE API =====

async function fetchAnimepaheInfo(id: string) {
  console.log('[fetchAnimepaheInfo] START - id:', id);
  const episodes = await paheFetchAllEpisodes(id);
  console.log('[fetchAnimepaheInfo] DONE - episodes:', episodes.length);
  return { id, episodes };
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

// Search Animepahe via self-hosted animepahe-api
const searchAnimepahe = async (query: string): Promise<Anime[] | string> => {
  console.log('[searchAnimepahe] START - query:', query);
  try {
    const results = await paheSearch(query);
    console.log('[searchAnimepahe] Got', results.length, 'results');

    const output: Anime[] = results.map(item => ({
      name: item.title,
      source: String(item.session),
      episodes: "0",
      img: item.poster,
      isUnread: false,
    }));

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

    // Get episodes from Animepahe - try both romaji and english titles
    const romajiTitle = media.title.romaji;
    const englishTitle = media.title.english;
    console.log('[getInfoAnilist] Searching Animepahe - romaji:', romajiTitle, 'english:', englishTitle);
    
    let episodes: any[] = [];
    let matchFound = false;
    
    // Try romaji title first
    if (romajiTitle) {
      const searchResults = await searchAnimepahe(romajiTitle);
      console.log('[getInfoAnilist] Romaji search returned', Array.isArray(searchResults) ? searchResults.length : 0, 'results');
      
      if (Array.isArray(searchResults) && searchResults.length > 0) {
        // Try to find exact match first
        let match = searchResults.find(result => 
          result.name.toLowerCase() === romajiTitle.toLowerCase()
        );
        
        // If no exact match, use first result
        if (!match) {
          match = searchResults[0];
          console.log('[getInfoAnilist] No exact match, using first result:', match.name);
        } else {
          console.log('[getInfoAnilist] Found exact match:', match.name);
        }
        
        console.log('[getInfoAnilist] Fetching Animepahe info for:', match.source);
        const animepaheInfo = await fetchAnimepaheInfo(match.source);
        episodes = animepaheInfo.episodes;
        matchFound = true;
        console.log('[getInfoAnilist] Got', episodes.length, 'episodes from Animepahe');
      }
    }
    
    // If romaji didn't work, try english title
    if (!matchFound && englishTitle && englishTitle !== romajiTitle) {
      console.log('[getInfoAnilist] Trying english title:', englishTitle);
      const searchResults = await searchAnimepahe(englishTitle);
      console.log('[getInfoAnilist] English search returned', Array.isArray(searchResults) ? searchResults.length : 0, 'results');
      
      if (Array.isArray(searchResults) && searchResults.length > 0) {
        let match = searchResults.find(result => 
          result.name.toLowerCase() === englishTitle.toLowerCase()
        );
        
        if (!match) {
          match = searchResults[0];
          console.log('[getInfoAnilist] No exact match, using first result:', match.name);
        } else {
          console.log('[getInfoAnilist] Found exact match:', match.name);
        }
        
        console.log('[getInfoAnilist] Fetching Animepahe info for:', match.source);
        const animepaheInfo = await fetchAnimepaheInfo(match.source);
        episodes = animepaheInfo.episodes;
        console.log('[getInfoAnilist] Got', episodes.length, 'episodes from Animepahe');
      }
    }

    if (episodes.length === 0) {
      console.warn('[getInfoAnilist] WARNING: No episodes found on Animepahe for:', romajiTitle || englishTitle);
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
