import { createSignal, Show } from 'solid-js'
import { t, type Language } from '../i18n'

interface ShareButtonProps {
  lang?: Language
  class?: string
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', 'true')
  el.style.position = 'fixed'
  el.style.top = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}

function canShare(): boolean {
  return typeof navigator !== 'undefined' && 'share' in navigator
}

export default function ShareButton(props: ShareButtonProps) {
  const [copied, setCopied] = createSignal(false)

  const handleShare = async () => {
    const url = window.location.href
    const dogName = document.querySelector('h1')?.textContent?.trim() || ''
    
    if (canShare()) {
      // Mobile: Use native share sheet
      try {
        await navigator.share({
          title: dogName,
          url: url
        })
      } catch (err) {
        // User cancelled or share failed, silently ignore
      }
    } else {
      // Desktop: Copy to clipboard
      try {
        await copyText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      } catch {
        // Silently fail if clipboard API not available
      }
    }
  }

  const lang = props.lang || 'pl'

  return (
    <button
      onClick={handleShare}
      class={`flex items-center justify-center w-9 h-9 text-sys-ink-primary/70 hover:text-sys-ink-primary bg-sys-paper-base/50 hover:bg-sys-paper-base border border-sys-paper-shadow hover:border-sys-ink-primary/30 rounded-lg transition-all duration-200 ${props.class || ''}`}
      aria-label={t('dogDetail.share', lang)}
      title={t('dogDetail.share', lang)}
    >
      <Show
        when={copied()}
        fallback={
          // Share icon (arrow up from box)
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
        }
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="w-4 h-4 text-sys-nature-grass"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </Show>
    </button>
  )
}
