import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SHELTER_ID = "fundacja-azylu-psim-aniol"
const BASE_URL = "https://www.psianiol.org.pl"
const SOURCE_URL = `${BASE_URL}/adopcje/`

const MAX_DOG_URLS = 200

const isPhotoUrl = (url: string): boolean =>
  /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)

const extractAzyluDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  const urls = [...document.querySelectorAll('a')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => !!href)
    .filter((href) => {
      // Include absolute URLs to adoption pages
      if (href.startsWith("https://www.psianiol.org.pl/adopcje/")) {
        const path = href.replace("https://www.psianiol.org.pl/adopcje/", "")
        // Exclude listing page itself, pagination, and category pages
        return path && 
               path !== "" && 
               !path.startsWith("page/") && 
               !path.startsWith("psy/") && 
               !path.startsWith("koty/") &&
               !path.startsWith("inne/")
      }
      // Include relative URLs
      if (href.startsWith("/adopcje/")) {
        const path = href.replace("/adopcje/", "")
        return path && 
               path !== "" && 
               !path.startsWith("page/") && 
               !path.startsWith("psy/") && 
               !path.startsWith("koty/") &&
               !path.startsWith("inne/")
      }
      return false
    })
    .map((href) => (href.startsWith("http") ? href : `${BASE_URL}${href}`))

  return [...new Set(urls)].slice(0, MAX_DOG_URLS)
}

const parseAgeFromText = (text: string): number | null => {
  const match = text.match(/(\d+)\s*(?:lat|lata|rok)/i)
  if (match) {
    return parseInt(match[1], 10) * 12
  }
  const monthMatch = text.match(/(\d+)\s*(?:miesiąc|miesiące|miesięcy|m-cy)/i)
  if (monthMatch) {
    return parseInt(monthMatch[1], 10)
  }
  return null
}

export const extractAzyluDogFromDetailPage = (html: string, url: string): RawDogData => {
  const { document } = parseHTML(html)

  const slug = url.split("/").filter(Boolean).pop() ?? ""
  const externalId = slug

  let name = "Unknown"
  
  const titleEl = document.querySelector("title")
  if (titleEl) {
    const titleMatch = titleEl.textContent?.match(/^([^\-]+)/)
    if (titleMatch) {
      name = titleMatch[1].trim()
    }
  }

  const infoText = document.body?.textContent?.toLowerCase() ?? ""

  let sex: "male" | "female" | "unknown" = "unknown"
  if (infoText.includes("samiec") || infoText.includes("pies")) {
    sex = "male"
  } else if (infoText.includes("samica") || infoText.includes("suczka")) {
    sex = "female"
  }

  const ageMonths = parseAgeFromText(infoText)

  const descriptionEl = document.querySelector(".entry-content, article, .post-content")
  let rawDescription = "No description"
  
  if (descriptionEl) {
    // Get text content, preserving some structure
    const paragraphs = [...descriptionEl.querySelectorAll("p")]
      .map((p) => p.textContent?.trim())
      .filter((text): text is string => !!text && text.length > 0)
    
    if (paragraphs.length > 0) {
      rawDescription = paragraphs.join("\n\n")
    } else {
      rawDescription = descriptionEl.textContent?.trim() || "No description"
    }
  }

  const photoUrls: string[] = []

  // Get main featured image
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content")
  if (ogImage && isPhotoUrl(ogImage)) {
    photoUrls.push(ogImage)
  }

  // Get all content images from uploads
  const contentImages = [...document.querySelectorAll('img')]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => !!src && isPhotoUrl(src))
    .filter((src) => src.includes("/wp-content/uploads/"))
    // Filter out small thumbnails (usually 150x150, 300x300)
    .filter((src) => !src.match(/-\d+x\d+\./) || src.match(/-(800x600|1024x768|1200x900)/))

  photoUrls.push(...contentImages)

  const photos = [...new Set(photoUrls)]

  return {
    fingerprint: `${SHELTER_ID}:${externalId}`,
    externalId,
    name,
    rawDescription,
    photos,
    sex,
    breed: null,
    ageMonths,
    size: null,
    sourceUrl: url,
  }
}

export const fundacjaAzyluAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Fundacja Azylu pod Psim Aniołem",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Warszawa",
  region: "Mazowieckie",

  fetch: (config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const request = HttpClientRequest.get(SOURCE_URL).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT)
      )

      const html = yield* client.execute(request).pipe(
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
      return html
    }),

  parse: (html, config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const dogUrls = extractAzyluDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const request = HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("User-Agent", USER_AGENT)
            )
            const detailHtml = yield* client.execute(request).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            return extractAzyluDogFromDetailPage(detailHtml, url)
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
            message: "Failed to parse Fundacja Azylu pages",
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
