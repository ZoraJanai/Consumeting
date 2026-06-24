import {
  ZStack, ProgressView, useState, Rectangle,
  VStack, HStack, RoundedRectangle, Text
} from "scripting"

let setVisibleGlobal: ((v: boolean) => void) | null = null
let setProviderBarGlobal: ((s: ProviderBarState | null) => void) | null = null

type ProviderBarState = { done: number; total: number; label: string }

// ── Provider progress bar (shown centered over the dim overlay) ────────────
function ProviderProgressBar({ done, total, label }: ProviderBarState) {
  const segments: JSX.Element[] = []
  for (let i = 0; i < total; i++) {
    segments.push(
      <RoundedRectangle
        key={`p-${i}`}
        fill={i < done ? "systemBlue" : "secondarySystemFill"}
        cornerRadius={2}
        frame={{ width: Math.max(8, Math.min(24, Math.floor(220 / total) - 4)), height: 6 }}
      />
    )
  }
  return (
    <ZStack
      frame={{ width: 260 }}
      padding={{ top: 20, bottom: 16, leading: 20, trailing: 20 }}
    >
      <RoundedRectangle fill="secondarySystemBackground" cornerRadius={18} />
      <VStack spacing={10} padding={{ top: 20, bottom: 16, leading: 20, trailing: 20 }}>
        <Text font={13} fontWeight="semibold" foregroundStyle="white">
          Fetching Source
        </Text>
        <HStack spacing={3}>{segments}</HStack>
        <Text font={12} foregroundStyle="lightGray" lineLimit={1} truncationMode="tail">
          {label}
        </Text>
      </VStack>
    </ZStack>
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
}

export function setProviderBar(done: number, total: number, label: string) {
  if (setProviderBarGlobal) setProviderBarGlobal({ done, total, label })
}

export function clearProviderBar() {
  if (setProviderBarGlobal) setProviderBarGlobal(null)
}