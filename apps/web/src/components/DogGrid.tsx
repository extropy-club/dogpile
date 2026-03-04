import { createResource, createSignal, onMount, onCleanup, For, Show, Switch, Match } from "solid-js"
import DogCard from "./DogCard"
import type { Dog } from "./types"
import { t } from "../i18n"

async function fetchDogs({ apiUrl, filters }: { apiUrl: string, filters: DogFilters }): Promise<Dog[]> {
  const cleanUrl = apiUrl.replace(/\/$/, "")
  const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost'
  const url = new URL(`${cleanUrl}/dogs`, base)
  
  if (filters.city) url.searchParams.set("city", filters.city)
  if (filters.size) url.searchParams.set("size", filters.size)
  if (filters.sex) url.searchParams.set("sex", filters.sex)
  if (filters.ids && filters.ids.length > 0) url.searchParams.set("ids", filters.ids.join(","))

  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error("Failed to fetch dogs")
  }
  const data = await response.json()
  return data.dogs
}

interface DogGridProps {
  apiUrl: string
  filters?: DogFilters
}

export interface DogFilters {
  city?: string
  size?: string
  sex?: string
  ids?: string[]
}

const SkeletonCard = () => (
  <article class="card h-full flex flex-col !p-3 bg-sys-paper-card">
    <div class="relative aspect-[4/5] w-full rounded-paper-img mb-4 bg-sys-paper-shadow/50 animate-pulse"></div>
    <div class="px-2 pb-2 flex-grow">
      <div class="h-8 w-3/4 bg-sys-paper-shadow/50 mb-2 rounded animate-pulse"></div>
      <div class="h-4 w-1/2 bg-sys-paper-shadow/50 mb-4 rounded animate-pulse"></div>
      <div class="flex gap-2 mb-4">
        <div class="h-6 w-12 rounded-full bg-sys-paper-shadow/50 animate-pulse"></div>
        <div class="h-6 w-12 rounded-full bg-sys-paper-shadow/50 animate-pulse"></div>
        <div class="h-6 w-12 rounded-full bg-sys-paper-shadow/50 animate-pulse"></div>
      </div>
    </div>
    <div class="border-t-2 border-dashed border-sys-paper-shadow pt-3 mt-auto flex justify-between items-center">
      <div class="h-4 w-1/3 bg-sys-paper-shadow/50 rounded animate-pulse"></div>
      <div class="h-4 w-1/4 bg-sys-paper-shadow/50 rounded animate-pulse"></div>
    </div>
  </article>
)

const EmptyState = (props: { isFavorites?: boolean }) => (
  <div class="col-span-full flex flex-col items-center justify-center py-24 text-center">
    <div class="text-sys-ink-primary/20 mb-6">
      <svg class="w-32 h-32" fill="currentColor" viewBox="0 0 24 24">
        <path d="M2.8 8c-1 2.3.3 4.9 2.7 5.9 2.4 1 5.1-.1 6-2.4.9-2.3-.4-4.9-2.8-5.9-2.3-1-5.1.1-6 2.4zm13.2-5c-1.9 1.7-1.7 4.7.3 6.3s4.8 1.4 6.6-.3c1.9-1.7 1.7-4.7-.3-6.3s-4.8-1.4-6.6.3zm-7.5-.5c-1.8-1.8-4.8-1.7-6.5.3-1.7 2-1.4 5 .3 6.8s4.8 1.7 6.5-.3c1.8-2 1.5-5-.3-6.8zm12.5 5.7c-2.4-.8-5 .5-5.8 2.9-.8 2.4.5 4.9 2.9 5.7 2.4.8 5-.5 5.8-2.9.8-2.4-.5-4.9-2.9-5.7zm-8.9 3.4c-3.4.3-6.1 3.2-6.1 6.6v.4c0 2.2 1.8 3.9 4 3.9h4c2.2 0 4-1.8 4-4v-.4c0-3.4-2.8-6.3-6.2-6.5z" />
      </svg>
    </div>
    <h3 id="empty-state-title" class="font-title text-2xl font-bold text-sys-ink-primary mb-2">
      {props.isFavorites ? t('empty.favoritesTitle') : t('empty.title')}
    </h3>
    <p class="text-sys-ink-primary/60 mb-8 text-lg">
      {props.isFavorites ? t('empty.favoritesSubtitle') : t('empty.subtitle')}
    </p>
    <a id="empty-state-show-all-button" href="/dogs" class="btn-secondary inline-block">
      {t('empty.showAll')}
    </a>
  </div>
)

export default function DogGrid(props: DogGridProps) {
  const [filters, setFilters] = createSignal<DogFilters>(props.filters || {})

  const [dogs] = createResource(
    () => ({ apiUrl: props.apiUrl, filters: filters() }),
    fetchDogs
  )

  onMount(() => {
    const handleFiltersChanged = (e: Event) => {
      const newFilters = (e as CustomEvent).detail
      setFilters(newFilters)
    }
    window.addEventListener('dog-filters-changed', handleFiltersChanged)
    onCleanup(() => window.removeEventListener('dog-filters-changed', handleFiltersChanged))
  })

  return (
    <section id="dog-grid-section" class="py-8">
      <Switch>
        <Match when={dogs.loading}>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8 card-grid">
            <For each={Array(6).fill(0)}>{() => <SkeletonCard />}</For>
          </div>
        </Match>

        <Match when={dogs.error}>
          <div class="text-center py-12 text-sys-state-urgent">
            Failed to load dogs. Please try again.
          </div>
        </Match>

        <Match when={dogs()}>
          <Show when={dogs()!.length > 0} fallback={<EmptyState isFavorites={!!props.filters?.ids} />}>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8 card-grid auto-rows-fr">
              <For each={dogs()}>
                {(dog) => <DogCard dog={dog} />}
              </For>
            </div>
          </Show>
        </Match>
      </Switch>
    </section>
  )
}
