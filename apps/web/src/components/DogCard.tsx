import { createSignal, onMount } from "solid-js"
import type { Dog } from "./types"
import ImageSlider from "./ImageSlider"
import { t } from "../i18n"
import { capitalizeWords } from "../utils/format"

interface Props {
  dog: Dog
}

function formatAge(ageEstimate: Dog["ageEstimate"]): string | null {
  if (!ageEstimate) return null
  const months = ageEstimate.months
  if (months < 12) return `${months} ${t('card.months')}`
  
  const years = Math.floor(months / 12)
  if (years === 1) return `1 ${t('card.year')}`
  
  // Polish pluralization
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'pl'
  if (lang === 'pl' || (!lang && typeof window !== 'undefined')) {
    if (years >= 2 && years <= 4) return `${years} ${t('card.years24')}`
    return `${years} ${t('card.years')}`
  }
  
  return `${years} ${t('card.years')}`
}

export default function DogCard(props: Props) {
  const [isFavorite, setIsFavorite] = createSignal(false)
  
  onMount(() => {
    if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
      setIsFavorite(localStorage.getItem(`favorite-${props.dog.id}`) === "true")
    }
  })

  const toggleFavorite = () => {
    const newValue = !isFavorite()
    setIsFavorite(newValue)
    if (typeof localStorage !== "undefined") {
      if (newValue) {
        localStorage.setItem(`favorite-${props.dog.id}`, "true")
      } else {
        localStorage.removeItem(`favorite-${props.dog.id}`)
      }
    }
  }

  const age = () => formatAge(props.dog.ageEstimate)
  const sex = () => {
    if (props.dog.sex === "male") return t('card.male')
    if (props.dog.sex === "female") return t('card.female')
    return null
  }

  return (
    <article id={`dog-card-${props.dog.id}`} class="group card card-appear w-full h-full flex flex-col relative !p-0 overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:rotate-1 hover:shadow-xl">
      {props.dog.urgent && (
        <div class="absolute top-3 left-3 tag-urgent rotate-[-5deg] z-20 shadow-md !bg-sys-heart-core !text-white px-3 py-1 font-bold rounded-sm">
          URGENT!
        </div>
      )}

      <div class="relative aspect-[4/5] w-full">
        <ImageSlider
          photos={props.dog.photos}
          photosGenerated={props.dog.photosGenerated}
          alt={capitalizeWords(props.dog.name)}
          class="h-full w-full"
          size="sm"
        />
        <a id={`dog-card-link-${props.dog.id}`} href={`/dogs/${props.dog.id}`} class="absolute inset-0 z-10">
          <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none z-0" />
          <span class="sr-only">View details for {capitalizeWords(props.dog.name)}</span>
        </a>

        <div class="absolute bottom-0 left-0 right-0 p-4 text-white z-20 pointer-events-none">
          <h3 class="font-title text-2xl font-bold leading-tight drop-shadow-md">
            {capitalizeWords(props.dog.name)}
          </h3>
          <p class="text-sm font-medium opacity-90 drop-shadow-sm">
            {age() && `${age()}`}{sex() && ` • ${sex()}`}
          </p>
        </div>

        <button
          id={`dog-card-favorite-button-${props.dog.id}`}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            toggleFavorite()
          }}
          class="absolute top-2 right-2 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center transition-all hover:scale-125 active:scale-150 z-30 group/heart"
          classList={{
            'text-white/70': !isFavorite(),
            'text-sys-heart-core': isFavorite(),
            'heart-pop': isFavorite(),
          }}
          aria-label={isFavorite() ? "Remove from favorites" : "Add to favorites"}
        >
          <div class="bg-black/20 backdrop-blur-sm rounded-full p-2 group-hover/heart:bg-black/40 transition-colors">
            {isFavorite() ? (
              <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 10-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
            ) : (
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
            )}
          </div>
        </button>

        {/* Personality tags on hover */}
        <div class="absolute top-4 right-4 flex flex-col items-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-20 pointer-events-none">
          {props.dog.personalityTags.slice(0, 3).map((tag: string) => (
            <span class="bg-white/90 backdrop-blur-sm text-sys-ink-primary text-xs font-bold px-2 py-1 rounded shadow-sm rotate-2 last:rotate-[-2deg]">
              #{tag}
            </span>
          ))}
        </div>
      </div>
      <div class="px-4 py-3 text-xs font-bold text-sys-ink-primary/50 uppercase tracking-wider flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        {props.dog.locationCity || "Unknown location"}
        {props.dog.isFoster && " (FOSTER HOME)"}
      </div>
    </article>
  )
}
