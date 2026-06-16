import { Image, useEffect, useState } from "scripting"
import {
  isLocalPosterPath,
  needsPosterAuthFetch,
  normalizePaheUrl,
  paheFetchImage,
} from "../scripts/animepaheClient"

type PosterAspectRatio = {
  contentMode: "fit" | "fill"
  value: number
}

type PaheImageProps = {
  url: string
  /** Sets Referer to /anime/{session} — matches browser poster requests. */
  animeSession?: string
  aspectRatio?: PosterAspectRatio
  frame?: Record<string, any>
  resizable?: boolean
  padding?: number
}

/**
 * Animepahe posters need Cloudflare cookies + Referer via fetch() — plain imageUrl cannot send them.
 * Anilist and other hosts use direct imageUrl.
 */
export function PaheImage(props: PaheImageProps) {
  const url = normalizePaheUrl(props.url)
  const needsAuth = needsPosterAuthFetch(url)
  const [displayUrl, setDisplayUrl] = useState("")
  const [filePath, setFilePath] = useState(isLocalPosterPath(url) ? url : "")

  const layout = {
    aspectRatio: props.aspectRatio,
    frame: props.frame,
    resizable: props.resizable,
    padding: props.padding,
  }

  useEffect(
    function () {
      if (!url) {
        setDisplayUrl("")
        setFilePath("")
        return
      }

      if (isLocalPosterPath(url)) {
        setFilePath(url)
        setDisplayUrl("")
        return
      }

      if (url.indexOf("data:image") === 0) {
        setDisplayUrl(url)
        setFilePath("")
        return
      }

      if (!needsAuth) {
        setDisplayUrl(url)
        setFilePath("")
        return
      }

      let cancelled = false
      setDisplayUrl("")
      setFilePath("")

      paheFetchImage(url, { animeSession: props.animeSession })
        .then(function (result) {
          if (cancelled || !result) return
          if (result.kind === "dataUrl") setDisplayUrl(result.url)
          if (result.kind === "file") setFilePath(result.path)
        })
        .catch(function (err) {
          if (!cancelled) console.log("[paheImage] error", String(err))
        })

      return function () {
        cancelled = true
      }
    },
    [url, needsAuth, props.animeSession]
  )

  if (filePath) {
    return <Image filePath={filePath} {...layout} />
  }
  if (displayUrl) {
    return <Image imageUrl={displayUrl} {...layout} />
  }
  if (!needsAuth && url) {
    return <Image imageUrl={url} {...layout} />
  }
  return <Image {...layout} />
}
