import { ZStack, ProgressView, useState, Rectangle } from "scripting"

let setVisibleGlobal: ((v: boolean) => void) | null = null

export function OverlayHost() {
  const [visible, setVisible] = useState(false)
  setVisibleGlobal = setVisible // give control to external fns

  let opacity;
  {(visible)?opacity=0.33:opacity=0}

  return (
    <ZStack>
      <Rectangle foregroundStyle="black" opacity={opacity}/>
      <ProgressView opacity={opacity*3}/>
    </ZStack>
  )
}

export function showOverlay() {
  if (setVisibleGlobal) setVisibleGlobal(true)
}

export function hideOverlay() {
  if (setVisibleGlobal) setVisibleGlobal(false)
}