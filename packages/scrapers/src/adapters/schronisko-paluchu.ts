import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SHELTER_ID = "schronisko-paluchu"
const BASE_URL = "https://napaluchu.waw.pl"
const SOURCE_URL = `${BASE_URL}/zwierzeta/zwierzeta-do-adopcji/?pet_page=1`

const MAX_DOG_URLS = 300

const isPhotoUrl = (url: string): boolean =>
  /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)

const extractPaluchuDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  const urls = [...document.querySelectorAll('.pets-list-pet-name a[href^="/pet/"]')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => !!href)
    .map((href) => (href.startsWith("http") ? href : `${BASE_URL}${href}`))

  return [...new Set(urls)].slice(0, MAX_DOG_URLS)
}

const parseAgeFromText = (text: string): number | null => {
  const match = text.match(/(\d+)\s*(?:lat|lata|rok)/i)
  if (match) {
    return parseInt(match[1], 10) * 12
  }
  const monthMatch = text.match(/(\d+)\s*(?:miesiąc|miesiące|miesięcy)/i)
  if (monthMatch) {
    return parseInt(monthMatch[1], 10)
  }
  return null
}

const parseWeightFromText = (text: string): number | null => {
  const match = text.match(/(\d+)\s*kg/i)
  if (match) {
    return parseInt(match[1], 10)
  }
  return null
}

const determineSizeFromWeight = (weightKg: number | null): "small" | "medium" | "large" | null => {
  if (weightKg === null) return null
  if (weightKg < 10) return "small"
  if (weightKg < 25) return "medium"
  return "large"
}

export const extractPaluchuDogFromDetailPage = (html: string, url: string): RawDogData => {
  const { document } = parseHTML(html)

  const slug = url.split("/").filter(Boolean).pop() ?? ""
  const externalId = slug

  let name = "Unknown"
  
  const titleEl = document.querySelector("title")
  if (titleEl) {
    const titleMatch = titleEl.textContent?.match(/^([^|]+)/)
    if (titleMatch) {
      name = titleMatch[1].trim()
    }
  }
  
  if (name === "Unknown") {
    const mainImage = document.querySelector(".pet-detail-main-image")
    const altText = mainImage?.getAttribute("alt")
    if (altText) {
      name = altText.trim()
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
  const weightKg = parseWeightFromText(infoText)
  const size = determineSizeFromWeight(weightKg)

  let breed: string | null = null
  const breedMatch = infoText.match(/rasa[:\s]+([^,\n]+)/i)
  if (breedMatch) {
    breed = breedMatch[1].trim()
  }

  const descriptionEl = document.querySelector(".pet-description.markdownit")
  let rawDescription = descriptionEl?.textContent?.trim() || "No description"
  
  if (rawDescription === "No description") {
    const altDesc = document.querySelector(".pet-description")
    rawDescription = altDesc?.textContent?.trim() || "No description"
  }

  const photoUrls: string[] = []

  const mainImage = document.querySelector(".pet-detail-main-image")
  const mainSrc = mainImage?.getAttribute("src")
  if (mainSrc && isPhotoUrl(mainSrc)) {
    photoUrls.push(mainSrc.startsWith("http") ? mainSrc : `${BASE_URL}${mainSrc}`)
  }

  const galleryImages = [...document.querySelectorAll('.pet-detail-gallery-thumb-square img, .pet-gallery img')]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => !!src && isPhotoUrl(src))
    .map((src) => (src.startsWith("http") ? src : `${BASE_URL}${src}`))

  photoUrls.push(...galleryImages)

  const photos = [...new Set(photoUrls)]

  return {
    fingerprint: `${SHELTER_ID}:${externalId}`,
    externalId,
    name,
    rawDescription,
    photos,
    sex,
    breed,
    ageMonths,
    size,
    sourceUrl: url,
  }
}

export const schroniskoPaluchuAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko na Paluchu",
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
      const dogUrls = extractPaluchuDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const request = HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("User-Agent", USER_AGENT)
            )
            const detailHtml = yield* client.execute(request).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            return extractPaluchuDogFromDetailPage(detailHtml, url)
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
            message: "Failed to parse Schronisko na Paluchu pages",
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
