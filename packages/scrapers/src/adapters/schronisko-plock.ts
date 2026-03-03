import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SHELTER_ID = "schronisko-plock"
const BASE_URL = "https://schronisko.pgkplock.pl"
const SOURCE_URL = `${BASE_URL}/adopcja/psy-do-adopcji`

const MAX_PAGES = 10
const MAX_DOG_URLS = 200

const isPhotoUrl = (url: string): boolean =>
  /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)

const extractPlockDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  const urls: string[] = []
  
  // Find all dog images with alt text "Zdjęcie [name]"
  const images = [...document.querySelectorAll('img[alt^="Zdjęcie"]')]
  
  images.forEach((img) => {
    const src = img.getAttribute("src")
    if (src) {
      // Extract ID from image path: /static/images/299/...
      const idMatch = src.match(/\/images\/(\d+)\//)
      if (idMatch) {
        const id = idMatch[1]
        urls.push(`${BASE_URL}/adopcja/zwierze/${id}`)
      }
    }
  })

  return [...new Set(urls)].slice(0, MAX_DOG_URLS)
}

const parseAgeFromText = (text: string): number | null => {
  // Format: "Wiek: 6 lat" or "Wiek: 1 rok"
  const match = text.match(/Wiek:\s*(\d+)\s*(?:lat|lata|rok)/i)
  if (match) {
    return parseInt(match[1], 10) * 12
  }
  return null
}

const parseWeightFromText = (text: string): number | null => {
  // Format: "Waga: 12" or "Waga: 12 kg"
  const match = text.match(/Waga:\s*(\d+)/i)
  if (match) {
    return parseInt(match[1], 10)
  }
  return null
}

export const extractPlockDogFromDetailPage = (html: string, url: string): RawDogData => {
  const { document } = parseHTML(html)

  const slug = url.split("/").filter(Boolean).pop() ?? ""
  const externalId = slug

  // Get name from title: "Ptyś - Szczegóły | Schronisko Płock"
  let name = "Unknown"
  const titleEl = document.querySelector("title")
  if (titleEl) {
    const titleMatch = titleEl.textContent?.match(/^([^\-–]+)/)
    if (titleMatch) {
      name = titleMatch[1].trim()
    }
  }

  // Get all text from body
  const bodyText = document.body?.textContent ?? ""

  // Parse age
  const ageMonths = parseAgeFromText(bodyText)

  // Parse weight
  const weightKg = parseWeightFromText(bodyText)

  // Determine size from weight
  let size: "small" | "medium" | "large" | null = null
  if (weightKg !== null) {
    if (weightKg < 10) size = "small"
    else if (weightKg < 25) size = "medium"
    else size = "large"
  }

  // Get sex
  let sex: "male" | "female" | "unknown" = "unknown"
  if (bodyText.includes("Płeć: Samiec")) {
    sex = "male"
  } else if (bodyText.includes("Płeć: Samica")) {
    sex = "female"
  }

  // Get castration status (though not part of RawDogData, can be in description)
  const isCastrated = bodyText.includes("Kastracja: Tak")

  // Get description from content area
  const descriptionEl = document.querySelector(".content-area, .editable-container")
  let rawDescription = descriptionEl?.textContent?.trim() || "No description"
  
  // If generic description, try to get info from body text
  if (rawDescription.includes("Stronę prowadzą pracownicy") || rawDescription === "No description") {
    // Extract relevant info from body text
    const relevantInfo = bodyText.split('\n').filter((line: string) => 
      line.includes("Wiek:") || 
      line.includes("Data urodzenia:") ||
      line.includes("Płeć:") ||
      line.includes("Waga:") ||
      line.includes("Kastracja:")
    ).join('\n')
    
    if (relevantInfo) {
      rawDescription = relevantInfo
    }
  }

  // Get photos
  const photoUrls: string[] = []

  // Main photo from the page
  const mainImg = document.querySelector('img[alt^="Zdjęcie"]')
  const mainSrc = mainImg?.getAttribute("src")
  if (mainSrc && isPhotoUrl(mainSrc)) {
    photoUrls.push(mainSrc.startsWith("http") ? mainSrc : `${BASE_URL}${mainSrc}`)
  }

  // Any other images
  const allImages = [...document.querySelectorAll('img')]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => !!src && isPhotoUrl(src))
    .filter((src) => src.includes(`/images/${externalId}/`))
    .map((src) => (src.startsWith("http") ? src : `${BASE_URL}${src}`))

  photoUrls.push(...allImages)

  const photos = [...new Set(photoUrls)]

  return {
    fingerprint: `${SHELTER_ID}:${externalId}`,
    externalId,
    name,
    rawDescription,
    photos,
    sex,
    breed: null, // Not specified on this site
    ageMonths,
    size,
    sourceUrl: url,
  }
}

export const schroniskoPlockAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko dla Zwierząt w Płocku",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Płock",
  region: "Mazowieckie",

  fetch: (config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      // Fetch all pages and combine
      let allHtml = ""
      
      for (let page = 1; page <= MAX_PAGES; page++) {
        const pageUrl = page === 1 ? SOURCE_URL : `${SOURCE_URL}?page=${page}`
        
        const request = HttpClientRequest.get(pageUrl).pipe(
          HttpClientRequest.setHeader("User-Agent", USER_AGENT)
        )

        const html = yield* client.execute(request).pipe(
          Effect.flatMap((res) => res.text),
          Effect.scoped,
          Effect.catchAll(() => Effect.succeed("")),
        )
        
        if (!html || html.length < 100) {
          // No more pages
          break
        }
        
        allHtml += html
      }
      
      return allHtml
    }),

  parse: (html, config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const dogUrls = extractPlockDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const request = HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("User-Agent", USER_AGENT)
            )
            const detailHtml = yield* client.execute(request).pipe(
              Effect.flatMap((r) => r.text), 
              Effect.scoped
            )
            return extractPlockDogFromDetailPage(detailHtml, url)
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
            message: "Failed to parse Schronisko Płock pages",
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
      breed: raw.breed ?? null,
      ageMonths: raw.ageMonths ?? null,
      size: raw.size ?? null,
      rawDescription: raw.rawDescription,
      sourceUrl: raw.sourceUrl ?? null,
      photos: raw.photos ?? [],
    }),
})
