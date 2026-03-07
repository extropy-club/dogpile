import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "schronisko-krakow"
const BASE_URL = "https://www.schronisko.krakow.pl"
const SOURCE_URL = `${BASE_URL}/Adopcje/PROCEDURY_I_WZORY_ANKIET/Psy/`

const MAX_LIST_PAGES = 20
const MAX_DOG_URLS = 300
const MAX_DETAIL_PHOTOS = 15

type ElementLike = {
  readonly textContent?: string | null
  readonly getAttribute?: (name: string) => string | null
  readonly querySelector?: (selectors: string) => ElementLike | null
  readonly querySelectorAll?: (selectors: string) => Iterable<ElementLike>
}

type DocumentLike = {
  readonly querySelector: (selectors: string) => ElementLike | null
  readonly querySelectorAll: (selectors: string) => Iterable<ElementLike>
}

const normalizeUrl = (url: string): string | null => {
  try {
    return new URL(url, BASE_URL).toString()
  } catch {
    return null
  }
}

const listPageUrl = (page: number): string =>
  page === 1 ? SOURCE_URL : `${SOURCE_URL}?p=${page}`

const extractDogUrlsFromListHtml = (html: string): readonly string[] => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }
  const links = [...document.querySelectorAll('a[href*="/Adopcje/PROCEDURY_I_WZORY_ANKIET/Psy/"]')].slice(0, 200)

  const urls: string[] = []
  const seen = new Set<string>()

  for (const a of links) {
    const href = a.getAttribute?.("href")
    if (!href) continue
    
    const normalized = normalizeUrl(href)
    if (!normalized) continue
    
    // Match pattern: /Adopcje/PROCEDURY_I_WZORY_ANKIET/Psy/{id}-{name}.html
    const match = normalized.match(/\/Adopcje\/PROCEDURY_I_WZORY_ANKIET\/Psy\/\d+-[^/]+\.html$/)
    if (!match) continue
    
    if (seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
  }

  return urls
}

const extractMaxPage = (document: DocumentLike): number => {
  const paginationLinks = [...document.querySelectorAll('a[href*="?p="]')].slice(0, 50)
  let max = 1

  for (const a of paginationLinks) {
    const href = a.getAttribute?.("href")
    if (!href) continue
    
    const match = href.match(/\?p=(\d+)/)
    if (match) {
      const page = Number.parseInt(match[1])
      if (Number.isFinite(page) && page > max) {
        max = page
      }
    }
  }

  return Math.min(max, MAX_LIST_PAGES)
}

const extractDogDetails = (html: string, sourceUrl: string): Omit<RawDogData, "fingerprint"> => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }

  // Extract ID from URL: /{id}-{name}.html
  const urlMatch = sourceUrl.match(/\/(\d+)-[^/]+\.html$/)
  const numericId = urlMatch?.[1] ?? sourceUrl
  const externalId = numericId

  // Extract name from <p><b>NAME</b></p>
  const nameEl = document.querySelector('p > b')
  const name = nameEl?.textContent?.trim() ?? "Unknown"

  // Extract description from content after metadata
  const allParagraphs = document.querySelectorAll('p')
  
  const descriptionParts: string[] = []
  let foundMetadata = false
  
  for (const p of allParagraphs) {
    const text = p.textContent?.trim() ?? ""
    
    // Skip metadata paragraphs
    if (text.startsWith('Data rejestracji:') || 
        text.startsWith('Gatunek:') || 
        text.startsWith('Rasa:') || 
        text.startsWith('Rozmiar:') ||
        text === name) {
      foundMetadata = true
      continue
    }
    
    // Skip ID pattern like "P 75/06/18"
    if (/^P\s+\d+\/\d+\/\d+$/.test(text)) {
      foundMetadata = true
      continue
    }
    
    // Collect description paragraphs
    if (text.length > 0 && foundMetadata) {
      descriptionParts.push(text)
    }
  }

  const rawDescription = descriptionParts.join('\n').trim()

  // Extract photos from gallery
  const photos: string[] = []
  const galleryLinks = [...document.querySelectorAll('.gallery_structure a.gallery')].slice(0, 30)
  
  for (const a of galleryLinks) {
    const href = a.getAttribute?.("href")
    if (!href) continue
    
    const normalized = normalizeUrl(href)
    if (!normalized) continue
    if (!normalized.includes('/files/objects/')) continue
    if (photos.includes(normalized)) continue
    
    photos.push(normalized)
    if (photos.length >= MAX_DETAIL_PHOTOS) break
  }

  return {
    externalId,
    name,
    rawDescription,
    photos,
    sex: "unknown", // Sex not displayed on detail pages
    sourceUrl,
  }
}

export const schroniskoKrakowAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko dla Bezdomnych Zwierząt w Krakowie",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Kraków",

  fetch: (config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return yield* client.get(SOURCE_URL).pipe(
        Effect.flatMap((res) => res.text),
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new ScrapeError({
              shelterId: config.shelterId,
              cause,
              message: `Failed to fetch ${SOURCE_URL}`,
            }),
        ),
      )
    }),

  parse: (html, config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const { document: firstDoc } = parseHTML(html) as unknown as { document: DocumentLike }

      const maxPage = extractMaxPage(firstDoc)
      const otherPages = maxPage > 1 ? Array.from({ length: maxPage - 1 }, (_, i) => i + 2) : []

      const otherPagesHtml = yield* Effect.all(
        otherPages.map((page) =>
          client
            .get(listPageUrl(page))
            .pipe(Effect.flatMap((res) => res.text), Effect.scoped, Effect.catchAll(() => Effect.succeed(null))),
        ),
        { concurrency: 3 },
      )

      const allListHtml = [html, ...otherPagesHtml.filter((h): h is string => !!h)].slice(0, MAX_LIST_PAGES)
      const allDogUrls = new Set<string>()

      for (const listHtml of allListHtml) {
        const urls = extractDogUrlsFromListHtml(listHtml)
        for (const url of urls) {
          allDogUrls.add(url)
          if (allDogUrls.size >= MAX_DOG_URLS) break
        }
        if (allDogUrls.size >= MAX_DOG_URLS) break
      }

      const dogUrls = [...allDogUrls].slice(0, MAX_DOG_URLS)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const res = yield* client.get(url).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            const details = extractDogDetails(res, url)

            return {
              fingerprint: `${SHELTER_ID}:${details.externalId}`,
              ...details,
            } satisfies RawDogData
          }).pipe(Effect.catchAll(() => Effect.succeed(null))),
        ),
        { concurrency: 5 },
      )

      return dogs.filter((d) => d !== null) as RawDogData[]
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ParseError({
            shelterId: config.shelterId,
            cause,
            message: "Failed to parse Kraków shelter pages",
          }),
      ),
    ),

  transform: (raw, config) =>
    Effect.succeed({
      shelterId: config.shelterId,
      externalId: raw.externalId,
      fingerprint: raw.fingerprint,
      name: raw.name,
      sex: raw.sex ?? "unknown",
      rawDescription: raw.rawDescription,
      sourceUrl: raw.sourceUrl ?? null,
      photos: raw.photos ?? [],
    }),
})
