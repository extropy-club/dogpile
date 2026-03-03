import { createSignal, Show, For, createEffect, onCleanup } from "solid-js"
import { getPhotoUrl, getPhotoSrcSet } from "../utils/photo-url"

interface Props {
  photos: string[]
  photosGenerated: string[]
  alt: string
  class?: string
  size?: "sm" | "lg"
  autoplay?: boolean
  interval?: number
  loading?: "lazy" | "eager"
  enableLightbox?: boolean
  onOpenLightbox?: (index: number) => void
}

export default function ImageSlider(props: Props) {
  const [index, setIndex] = createSignal(0)
  const [isPaused, setIsPaused] = createSignal(false)
  const size = () => props.size || "lg"

  const allPhotos = () => [...(props.photosGenerated || []), ...(props.photos || [])]

  const currentPhoto = () => allPhotos()[index()]
const currentSrc = () => currentPhoto() ? getPhotoUrl(currentPhoto(), size()) : '/placeholder-dog.jpg'
const currentSrcSet = () => currentPhoto() ? getPhotoSrcSet(currentPhoto()) : undefined

  createEffect(() => {
    const photos = allPhotos()
    const currentIdx = index()
    const nextIdx = (currentIdx + 1) % photos.length

    if (photos.length <= 1 || !photos[nextIdx]) return

    const nextSrc = getPhotoUrl(photos[nextIdx], size())
    const link = document.createElement('link')
    link.rel = 'prefetch'
    link.as = 'image'
    link.href = nextSrc
    document.head.appendChild(link)

    onCleanup(() => {
      if (link.parentNode) {
        link.parentNode.removeChild(link)
      }
    })
  })

  const next = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    setIndex((i) => (i + 1) % allPhotos().length)
  }

  const prev = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    setIndex((i) => (i - 1 + allPhotos().length) % allPhotos().length)
  }

  return (
    <div
      class={`relative group overflow-hidden ${props.class || ''}`}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <img
        src={currentSrc()}
        srcset={currentSrcSet() || undefined}
        sizes={currentSrcSet() ? "(max-width: 640px) 100vw, 800px" : undefined}
        width={size() === "sm" ? 400 : 1200}
        height={size() === "sm" ? 300 : 900}
        alt={props.alt}
        class={`nostalgia-img w-full h-full object-cover transition-opacity duration-300 ${
          props.enableLightbox ? "cursor-pointer hover:scale-105" : ""
        }`}
        fetchpriority={props.loading === "eager" ? "high" : "auto"}
        decoding="async"
        loading={props.loading || "lazy"}
        onClick={() => props.enableLightbox && props.onOpenLightbox?.(index())}
      />

     {/* Controls (only show if multiple photos) */}
     <Show when={allPhotos().length > 1}>
       <button 
         onClick={prev}
          class="absolute left-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white w-8 h-8 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-30"
         aria-label="Previous photo"
       >
         <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="15 18 9 12 15 6"/>
         </svg>
       </button>
       <button 
         onClick={next}
          class="absolute right-2 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white w-8 h-8 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-30"
         aria-label="Next photo"
       >
         <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="9 18 15 12 9 6"/>
         </svg>
       </button>
       
       {/* Dots */}
        <div class="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5 z-30">
         <For each={allPhotos()}>
           {(_, i) => (
             <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setIndex(i()) }}
                class={`w-2 h-2 rounded-full transition-colors ${i() === index() ? 'bg-white' : 'bg-white/50 hover:bg-white/70'}`}
                aria-label={`Go to photo ${i() + 1}`}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
