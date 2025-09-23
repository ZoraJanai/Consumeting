import {
  HStack, Button, Label, Navigation, Script, Spacer, TabView, Text,
  VStack, ZStack, TextField, useState, RoundedRectangle
} from "scripting"

import { SettingsPage } from "./Pages/Settings"
import { CachePage } from "./Pages/Cache"
import { QueuePage } from "./Pages/Queue"
import { HomePage } from "./Pages/Home"
import { OverlayHost } from "./Pages/Loading"

type TabChildProps = {
  onCacheSaved?: () => void
  onQueueSaved?: () => void
  onBadgeChange?: (n: number) => void
  tag?: number | string
  tabItem?: any
  badge?: any
}

function Example() {
  const [tabIndex, setTabIndex] = useState(0)

  // 🔔 every time cache is saved anywhere, bump this
  const [cacheVersion, setCacheVersion] = useState(0)
  const onCacheSaved = () => setCacheVersion(v => v + 1)
  const [cacheBadge, setCacheBadge] = useState<number>(0)
  const [queueVersion, setQueueVersion] = useState(0)
  const onQueueSaved = () => setQueueVersion(v => v + 1)
  const [queueBadge, setQueueBadge] = useState<number>(0)
  
  return (
    <TabView
      tabIndex={tabIndex}
      onTabIndexChanged={setTabIndex}
    >

      <HomeView
        key={`home-${cacheVersion}`}   // ⬅️ add this
        tag={0}
        tabItem={<Label title={"Home"} systemImage={"cube.transparent.fill"} />}
        onCacheSaved={onCacheSaved}
        onQueueSaved={onQueueSaved}
      />
      <CacheView
        badge={cacheBadge}
        key={cacheVersion} // ⬅️ force CachePage to remount & reload after saves
        tag={1}
        tabItem={<Label title={"Cache"} systemImage={"clock.fill"} />}
        onCacheSaved={onCacheSaved}
        onQueueSaved={onQueueSaved}
        onBadgeChange={setCacheBadge}
      />
      

      <QueueView
        key={queueVersion}
        tag={2}
        badge={queueBadge}
        tabItem={<Label title={"Queue"} systemImage={"square.grid.2x2.fill"} />}
        onBadgeChange={setQueueBadge}
      />
      <SettingsView
        tag={3}
        tabItem={<Label title={"Settings"} systemImage={"gearshape.fill"} />}
      />
    </TabView>
  )
}

function HomeView(props: TabChildProps) {
  return <HomePage onCacheSaved={props.onCacheSaved} 
                   onQueueSaved={props.onQueueSaved}
           />
}

function CacheView(props: TabChildProps) {
  return <CachePage onCacheSaved={props.onCacheSaved}
                    onQueueSaved={props.onQueueSaved}
                    onBadgeChange={props.onBadgeChange}
           />
}

// leave these as-is
function QueueView(props: { onBadgeChange?: (n: number) => void }) {
  return <QueuePage onBadgeChange={props.onBadgeChange} />
}
function SettingsView() { return <SettingsPage /> }

async function run() {
  await Navigation.present({
    element: (
      <ZStack>
        <Example />
        <OverlayHost />
      </ZStack>
    )
  })
  Script.exit()
}
run()