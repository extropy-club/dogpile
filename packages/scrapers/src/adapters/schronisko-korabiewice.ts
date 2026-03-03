import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SHELTER_ID = "schronisko-korabiewice"
const BASE_URL = "https://schronisko.info.pl"
const SOURCE_URL = `${BASE_URL}/zwierzak/`

const MAX_DOG_URLS = 200

const isPhotoUrl = (url: string): boolean =>
  /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)

const extractKorabiewiceDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  const urls = [...document.querySelectorAll('a')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => !!href)
    .filter((href) => {
      // Include absolute URLs to zwierzak pages
      if (href.startsWith("https://schronisko.info.pl/zwierzak/")) {
        const path = href.replace("https://schronisko.info.pl/zwierzak/", "")
        // Exclude listing page itself, pagination, and feed
        return path && 
               path !== "" && 
               !path.startsWith("page/") && 
               !path.startsWith("feed/")
      }
      // Include relative URLs
      if (href.startsWith("/zwierzak/")) {
        const path = href.replace("/zwierzak/", "")
        return path && 
               path !== "" && 
               !path.startsWith("page/") && 
               !path.startsWith("feed/")
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

export const extractKorabiewiceDogFromDetailPage = (html: string, url: string): RawDogData => {
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
    breed: null,
    ageMonths,
    size: null,
    sourceUrl: url,
  }
}

export const schroniskoKorabiewiceAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko w Korabiewicach",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Korabiewice",
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
      const dogUrls = extractKorabiewiceDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const request = HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("User-Agent", USER_AGENT)
            )
            const detailHtml = yield* client.execute(request).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            return extractKorabiewiceDogFromDetailPage(detailHtml, url)
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
            message: "Failed to parse Schronisko w Korabiewicach pages",
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
