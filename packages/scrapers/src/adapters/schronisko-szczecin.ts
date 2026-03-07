import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "schronisko-szczecin"
const BASE_URL = "https://schronisko.szczecin.pl"
const SOURCE_URL = `${BASE_URL}/zwierzeta/psy-do-adopcji/`

const MAX_LIST_PAGES = 10
const MAX_DOG_URLS = 200
const MAX_DETAIL_PHOTOS = 10

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
  page === 1 ? SOURCE_URL : `${SOURCE_URL}${page}/`

const extractDogUrlsFromListHtml = (html: string): readonly string[] => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }
  const links = [...document.querySelectorAll('a[href*="/zwierze/"]')].slice(0, 200)

  const urls: string[] = []
  const seen = new Set<string>()

  for (const a of links) {
    const href = a.getAttribute?.("href")
    if (!href) continue
    
    const normalized = normalizeUrl(href)
    if (!normalized) continue
    
    // Match pattern: /zwierze/{name}/
    if (!normalized.match(/\/zwierze\/[^/]+\/$/)) continue
    
    if (seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
  }

  return urls
}

const extractMaxPage = (document: DocumentLike): number => {
  const paginationLinks = [...document.querySelectorAll('.page-numbers')].slice(0, 20)
  let max = 1

  for (const a of paginationLinks) {
    const text = a.textContent?.trim()
    if (!text) continue
    
    const pageNum = Number.parseInt(text)
    if (Number.isFinite(pageNum) && pageNum > max) {
      max = pageNum
    }
  }

  return Math.min(max, MAX_LIST_PAGES)
}

const extractDogDetails = (html: string, sourceUrl: string): Omit<RawDogData, "fingerprint"> => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }

  // Extract ID from URL: /zwierze/{name}/
  const urlMatch = sourceUrl.match(/\/zwierze\/([^/]+)\/$/)
  const externalId = urlMatch?.[1] ?? sourceUrl

  // Extract name from h1
  const nameEl = document.querySelector('h1')
  const name = nameEl?.textContent?.trim() ?? "Unknown"

  // Check if already adopted
  const pageText = document.querySelector('body')?.textContent ?? ""
  const isAdopted = pageText.toUpperCase().includes("ZAADOPTOWANY") || 
                    pageText.toUpperCase().includes("ZAREZERWOWANY")

  // Extract description - look for text after metadata sections
  let rawDescription = ""
  const allText = pageText
  const descMatch = allText.match(/\bSpajki[^]*ZAADOPTOWANY/i) || 
                    allText.match(/\b[A-Z][a-z]+[^]*\b(wr[oó]cił|trafił|jest|ma\s+zaledwie)/i)
  
  if (descMatch) {
    rawDescription = descMatch[0].replace(/ZAADOPTOWANY.*$/i, "").trim()
  }

  // Extract photos from wp-content/uploads
  const photos: string[] = []
  const imageNodes = [...document.querySelectorAll('img')].slice(0, 50)
  
  for (const img of imageNodes) {
    const src = img.getAttribute?.("src")
    if (!src) continue
    
    const normalized = normalizeUrl(src)
    if (!normalized) continue
    if (!normalized.includes('/wp-content/uploads/')) continue
    // Skip logos and icons
    if (normalized.includes('logo') || normalized.includes('fav')) continue
    if (photos.includes(normalized)) continue
    
    photos.push(normalized)
    if (photos.length >= MAX_DETAIL_PHOTOS) break
  }

  // Try to determine sex from page text
  let sex: "male" | "female" | "unknown" = "unknown"
  const lowerText = pageText.toLowerCase()
  if (lowerText.includes('samiec') || lowerText.includes('piesek') || lowerText.includes('kocur')) {
    sex = "male"
  } else if (lowerText.includes('samica') || lowerText.includes('suczka') || lowerText.includes('kotka')) {
    sex = "female"
  }

  return {
    externalId,
    name,
    rawDescription,
    photos,
    sex,
    sourceUrl,
  }
}

export const schroniskoSzczecinAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko dla Bezdomnych Zwierząt w Szczecinie",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Szczecin",

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
            message: "Failed to parse Szczecin shelter pages",
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
