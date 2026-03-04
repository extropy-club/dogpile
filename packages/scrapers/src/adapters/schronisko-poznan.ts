import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "schronisko-poznan"
const BASE_URL = "https://schronisko.com"
const SOURCE_URL = `${BASE_URL}/zwierzeta/psy/`

const MAX_DOG_URLS = 300

const isPhotoUrl = (url: string): boolean =>
  /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)

export const extractPoznanDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  // Dogs are loaded as WordPress us_portfolio post type in <article> elements
  // Extract post IDs and construct URLs using ?p=[post-id] format
  const postIds = [...document.querySelectorAll('article.us_portfolio[data-id]')]
    .map((article) => article.getAttribute("data-id"))
    .filter((id): id is string => !!id && /^\d+$/.test(id))

  // Build URLs using post ID query parameter (WordPress will redirect to actual URL)
  const urls = postIds.map((id) => `${BASE_URL}/?p=${id}`)

  return [...new Set(urls)].slice(0, MAX_DOG_URLS)
}

export const extractPoznanDogFromDetailPage = (html: string, url: string): RawDogData => {
  const { document } = parseHTML(html)

  // Extract post ID from query parameter ?p=12345
  const urlObj = new URL(url)
  const externalId = urlObj.searchParams.get("p") ?? url.split("/").filter(Boolean).pop() ?? ""

  // Try og:title first (most reliable), then h1, then fallback
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")
  const name = ogTitle?.replace(" - Schronisko dla zwierząt w Poznaniu", "").trim() 
    ?? document.querySelector("h1")?.textContent?.trim() 
    ?? "Unknown"

  const descriptionParagraphs = [...document.querySelectorAll(".entry-content p, .dog-description p, article p")]
    .map((p) => p.textContent?.trim() ?? "")
    .filter((s) => s.length > 0)
  const rawDescription = descriptionParagraphs.join("\n") || "No description"

  const photoUrls: string[] = []

  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content")
  if (ogImage && isPhotoUrl(ogImage)) {
    photoUrls.push(ogImage.startsWith("http") ? ogImage : `${BASE_URL}${ogImage}`)
  }

  const contentImages = [...document.querySelectorAll('img[src*="/wp-content/uploads/"]')]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => !!src && isPhotoUrl(src))
    .map((src) => (src.startsWith("http") ? src : `${BASE_URL}${src}`))

  photoUrls.push(...contentImages)

  const photos = [...new Set(photoUrls)]

  let sex: "male" | "female" | "unknown" = "unknown"
  const pageText = document.body?.textContent?.toLowerCase() ?? ""
  if (pageText.includes("samiec") || pageText.includes("pies")) {
    sex = "male"
  } else if (pageText.includes("samica") || pageText.includes("suczka") || pageText.includes("suka")) {
    sex = "female"
  }

  return {
    fingerprint: `${SHELTER_ID}:${externalId}`,
    externalId,
    name,
    rawDescription,
    photos,
    sex,
    sourceUrl: url,
  }
}

export const schroniskoPoznanAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko dla Zwierząt w Poznaniu",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Poznań",
  region: "Wielkopolskie",

  fetch: (config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const html = yield* client.get(SOURCE_URL).pipe(
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
      const dogUrls = extractPoznanDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const detailHtml = yield* client.get(url).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            return extractPoznanDogFromDetailPage(detailHtml, url)
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
            message: "Failed to parse Schronisko Poznań pages",
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
