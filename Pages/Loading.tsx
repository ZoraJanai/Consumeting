import {
  ZStack, ProgressView, useState, Rectangle,
  VStack, HStack, RoundedRectangle, Text
} from "scripting"

let setVisibleGlobal: ((v: boolean) => void) | null = null
let setProviderBarGlobal: ((s: ProviderBarState | null) => void) | null = null

type ProviderBarState = { done: number; total: number; label: string }

// ── Provider progress bar — floats over the dim, no card background ─────────
function ProviderProgressBar({ done, total, label }: ProviderBarState) {
  const segW = Math.max(10, Math.min(28, Math.floor(240 / total) - 4))
  const segments: JSX.Element[] = []
  for (let i = 0; i < total; i++) {
    segments.push(
      <RoundedRectangle
        key={`p-${i}`}
        fill={i < done ? "systemBlue" : "tertiaryLabel"}
        cornerRadius={3}
        frame={{ width: segW, height: 6 }}
      />
    )
  }
  return (
    <VStack spacing={8}>
      <HStack spacing={4}>{segments}</HStack>
      <Text font={12} foregroundStyle="white" lineLimit={1} truncationMode="tail">
        {label}
      </Text>
    </VStack>
  )
}

export function OverlayHost() {
  const [visible, setVisible] = useState(false)
  const [providerBar, setProviderBar] = useState<ProviderBarState | null>(null)
  setVisibleGlobal = setVisible
  setProviderBarGlobal = setProviderBar

  const opacity = visible ? 0.33 : 0

  return (
    <ZStack>
      <Rectangle foregroundStyle="black" opacity={opacity} />
      {providerBar
        ? <ProviderProgressBar done={providerBar.done} total={providerBar.total} label={providerBar.label} />
        : <ProgressView opacity={opacity * 3} />
      }
    </ZStack>
  )
}

export function showOverlay() {
  if (setVisibleGlobal) setVisibleGlobal(true)
}

export function hideOverlay() {
  if (setVisibleGlobal) setVisibleGlobal(false)
  if (setProviderBarGlobal) setProviderBarGlobal(null) // always clear bar on hide
}

export function setProviderBar(done: number, total: number, label: string) {
  if (setProviderBarGlobal) setProviderBarGlobal({ done, total, label })
}

export function clearProviderBar() {
  if (setProviderBarGlobal) setProviderBarGlobal(null)
}