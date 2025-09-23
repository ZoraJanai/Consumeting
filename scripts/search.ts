import { fetch } from "scripting"

// Type definitions
type ProviderType = "animepahe" | string
type TitlesMap = { [key: string]: string }
type Anime = {
  name: string
  source: string //used here as provider
  episodes: string //used here as year of release
  img: string
  isUnread: boolean}


interface BaseResult {
  id: string
  totalEpisodes?: number
  image: string 
  releaseDate: number
}

interface AnilistResult extends BaseResult {
  title: { romaji: string };
}

interface AnimepaheResult extends BaseResult {
  title: string;
}


interface AnimeResultSimple {
  id: string
  title: string
}

interface Episode {
  id: string
  number: number
}

interface AnimeInfo {
  episodes: Episode[]
}


interface BaseInfo {
  img: string
  total: string
  ids: string[]
  id: string
  episode: string
  name: string
}

// Global variables (you’ll need to set these)
//declare const baseUrl: string
//declare const provider: ProviderType
const baseUrl= "https://consumet-srgm.vercel.app"
const provider = "animepahe"

// Anilist search function
const searchAnilist = async (query: string): Promise<Anime[] | string> => {
  switch (provider) {
    case "animepahe":
      try {
        const url = `${baseUrl}/meta/anilist/${(query.replaceAll("/"," "))}`
        const response = await fetch(url)

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const body = await response.json()
        const results: AnilistResult[] = body.results

        const output = []
        for (let i = 0; i < results.length; i++) {
          let searchEntry: Anime = {
name: results[i].title.romaji,
source: String(results[i].id),
episodes: "0",
img: results[i].image,
isUnread: false
}
          output.push(searchEntry)
        }

        //titles["One-time Search"] = "animepahe"

        //console.log(output)
        return output
      } catch (error) {
        console.error("Error in searchAnilist:", error)
        throw error
      }

    default:
      return "not supported"
  }
}


// Search Animepahe directly
const searchAnimepahe = async (query: string): Promise<Anime[] | string> => {
  try {
    const url = `${baseUrl}/anime/animepahe/${(query.replaceAll(/[^\p{L}\p{N}\s]/gu,""))}`
    console.log(url)
        const response = await fetch(url)

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const body = await response.json()
        const results: AnimepaheResult[] = body.results

        const output = []
        for (let i = 0; i < results.length; i++) {
          let searchEntry: Anime = {
name: results[i].title,
source: String(results[i].id),
episodes: "0",
img: results[i].image,
isUnread: false
}
          output.push(searchEntry)
        }

        //titles["One-time Search"] = "animepahe"

        //console.log(output)
        return output
  } catch (error) {
    console.error("Error in searchAnimepahe:", error)
    throw error
  }
}


// Get anime info from Anilist
const getInfoAnilist = async (anime: Anime): Promise<BaseInfo> => {
  try {
    const url = `${baseUrl}/meta/anilist/info/${anime.source}?provider=animepahe`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const bodyResult = await response.json()
    const body: Episode[] = bodyResult.episodes

    let totalEP = body.length
    const ids: string[] = []

    for (let i = 0; i < body.length; i++) {
      if (Math.ceil(body[i].number) === body[i].number && body[i].number !== 0) {
        ids.push(body[i].id)
      } else {
        totalEP--
      }
    }

    const output: BaseInfo = {
      total: String(totalEP),
      ids: ids,
      name: bodyResult.title.romaji,
      id: bodyResult.id,
      episode: "none",
      img:anime.img
      
    }
    console.log(output)
    return output
  } catch (error) {
    console.error("Error in getInfoAnilist:", error)
    throw error
  }
}

// Get anime info from Animepahe
const getInfoAnimepahe = async (anime: Anime): Promise<BaseInfo> => {
  console.log(anime.name)
  let match: Anime | undefined
  try {
    const search = await searchAnimepahe(anime.name)
    console.log(search)
    if (Array.isArray(search)) {
    match = search.find(obj => obj.name === anime.name)
  if (match) {
    console.log("Got exact match:", match)
  } else {
    console.log("No match")
  }
} else {
  console.log("Error / no results:", search) // found is a string hereC
}
    const url = `${baseUrl}/anime/animepahe/info/${match!.source}`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const bodyResult = await response.json()
    const body: Episode[] = bodyResult.episodes

    let totalEP = body.length
    const ids: string[] = []

    for (let i = 0; i < body.length; i++) {
      if (Math.ceil(body[i].number) === body[i].number && body[i].number !== 0) {
        ids.push(body[i].id)
      } else {
        totalEP--
      }
    }

    const output: BaseInfo = {
      total: String(totalEP),
      ids: ids,
      name: bodyResult.title,
      id: bodyResult.id,
      episode: "none",
      img: anime.img
      
    }

    return output
  } catch (error) {
    //console.error("Error in getInfoAnimepahe:", error)
    throw error
  }
}

// Export all functions
export {
  searchAnilist,
  getInfoAnilist,
  searchAnimepahe,
  getInfoAnimepahe,
  type TitlesMap,
  type BaseInfo,
  type ProviderType
}