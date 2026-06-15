import { Image, Text, useEffect, useState } from "scripting"
import { isPaheProtectedUrl, normalizePaheUrl, paheFetchImage } from "../scripts/animepaheClient"

type PaheImageProps = {
  url: string
  aspectRatio?: { contentMode: string; value: number }
  frame?: Record<string, any>
  resizable?: boolean
  padding?: number
}

/** Poster / CDN image with animepahe session headers (Image imageUrl cannot send cookies). */
export function PaheImage(props: PaheImageProps) {
  const url = normalizePaheUrl(props.url)
  const needsAuth = isPaheProtectedUrl(url)
  const [uiImage, setUiImage] = useState<any>(null)
  const [filePath, setFilePath] = useState("")

  useEffect(
    function () {
      let cancelled = false
      setUiImage(null)
      setFilePath("")

      if (!needsAuth || !url) return

      paheFetchImage(url).then(function (result) {
        if (cancelled || !result) return
        if (result.kind === "ui") setUiImage(result.image)
        if (result.kind === "file") setFilePath(result.path)
      })

      return function () {
        cancelled = true
      }
    },
    [url, needsAuth]
  )

  if (!needsAuth) {
    return (
      <Image
        imageUrl={url}
        aspectRatio={props.aspectRatio}
        frame={props.frame}
        resizable={props.resizable}
        padding={props.padding}
      />
    )
  }

  if (uiImage) {
    return (
      <Image
        image={uiImage}
        aspectRatio={props.aspectRatio}
        frame={props.frame}
        resizable={props.resizable}
        padding={props.padding}
      />
    )
  }

  if (filePath) {
    return (
      <Image
        filePath={filePath}
        aspectRatio={props.aspectRatio}
        frame={props.frame}
        resizable={props.resizable}
        padding={props.padding}
      />
    )
  }

  return (
    <Image
      aspectRatio={props.aspectRatio}
      frame={props.frame}
      resizable={props.resizable}
      padding={props.padding}
      placeholder={<Text foregroundStyle="secondaryLabel"> </Text>}
    />
  )
}
