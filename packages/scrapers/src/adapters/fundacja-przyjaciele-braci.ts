import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SHELTER_ID = "fundacja-przyjaciele-braci"
const BASE_URL = "https://www.fundacjapsom.pl"
const SOURCE_URL = `${BASE_URL}/zwierzeta/psy-do-adopcji/`

const MAX_DOG_URLS = 100

const isPhotoUrl = (url: string): boolean =>
  /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)

const extractNowyDworDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  const urls = [...document.querySelectorAll('a')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => !!href)
    .filter((href) => {
      // Include absolute URLs to dog pages
      if (href.startsWith("https://www.fundacjapsom.pl/wszystkie-zwierzeta/psy-do-adopcji/")) {
        return true
      }
      // Include relative URLs
      if (href.startsWith("/wszystkie-zwierzeta/psy-do-adopcji/")) {
        return true
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

export const extractNowyDworDogFromDetailPage = (html: string, url: string): RawDogData => {
  const { document } = parseHTML(html)

  const slug = url.split("/").filter(Boolean).pop() ?? ""
  const externalId = slug

  let name = "Unknown"
  
  const titleEl = document.querySelector("title")
  if (titleEl) {
    const titleMatch = titleEl.textContent?.match(/^([^\-–]+)/)
    if (titleMatch) {
      name = titleMatch[1].trim()
    }
  }
  
  if (name === "Unknown") {
    const h1El = document.querySelector("h1")
    if (h1El) {
      name = h1El.textContent?.trim() ?? "Unknown"
    }
  }

  // Extract data from the checklist
  const checklistItems = [...document.querySelectorAll('.fusion-checklist li, .fusion-li-item')]
  const infoMap = new Map<string, string>()
  
  checklistItems.forEach((item) => {
    const content = item.textContent?.trim() ?? ""
    if (content.includes(":")) {
      const [key, value] = content.split(":", 2)
      if (key && value) {
        infoMap.set(key.trim().toLowerCase(), value.trim())
      }
    }
  })

  // Get sex
  let sex: "male" | "female" | "unknown" = "unknown"
  const sexValue = infoMap.get("płeć")
  if (sexValue) {
    if (sexValue.toLowerCase().includes("samiec") || sexValue.toLowerCase().includes("pies")) {
      sex = "male"
    } else if (sexValue.toLowerCase().includes("samica") || sexValue.toLowerCase().includes("suczka")) {
      sex = "female"
    }
  }

  // Get breed
  let breed: string | null = infoMap.get("rasa") ?? null

  // Get birth year and calculate age
  const birthYear = infoMap.get("ur.")
  let ageMonths: number | null = null
  if (birthYear) {
    const yearMatch = birthYear.match(/(\d{4})/)
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10)
      const currentYear = new Date().getFullYear()
      ageMonths = (currentYear - year) * 12
    }
  }
  
  // Parse age directly if not from birth year
  if (ageMonths === null) {
    const ageText = document.body?.textContent ?? ""
    ageMonths = parseAgeFromText(ageText)
  }

  // Get weight
  const weightText = infoMap.get("waga")
  let weightKg: number | null = null
  if (weightText) {
    const weightMatch = weightText.match(/(\d+)/)
    if (weightMatch) {
      weightKg = parseInt(weightMatch[1], 10)
    }
  }

  // Determine size from weight or text
  let size: "small" | "medium" | "large" | null = null
  const sizeValue = infoMap.get("wielkość")
  if (sizeValue) {
    if (sizeValue.includes("mał")) size = "small"
    else if (sizeValue.includes("średn")) size = "medium"
    else if (sizeValue.includes("duż")) size = "large"
  }
  
  if (size === null && weightKg !== null) {
    if (weightKg < 10) size = "small"
    else if (weightKg < 25) size = "medium"
    else size = "large"
  }

  // Get description
  const descriptionEl = document.querySelector(".fusion-content-tb, .post-content, .entry-content")
  let rawDescription = descriptionEl?.textContent?.trim() || "No description"

  // Get photos
  const photoUrls: string[] = []

  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content")
  if (ogImage && isPhotoUrl(ogImage)) {
    photoUrls.push(ogImage)
  }

  const contentImages = [...document.querySelectorAll('img')]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => !!src && isPhotoUrl(src))
    .filter((src) => src.includes("/wp-content/uploads/"))
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
    breed,
    ageMonths,
    size,
    sourceUrl: url,
  }
}

export const fundacjaPrzyjacieleBraciAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Fundacja Przyjaciele Braci Mniejszych - Schronisko w Nowym Dworze Mazowieckim",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Nowy Dwór Mazowiecki",
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
      const dogUrls = extractNowyDworDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const request = HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("User-Agent", USER_AGENT)
            )
            const detailHtml = yield* client.execute(request).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            return extractNowyDworDogFromDetailPage(detailHtml, url)
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
            message: "Failed to parse Fundacja Przyjaciele Braci pages",
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
