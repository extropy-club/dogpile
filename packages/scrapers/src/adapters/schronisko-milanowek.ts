import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "schronisko-milanowek"
const BASE_URL = "https://schroniskomilanowek.pl"
const SOURCE_URL = `${BASE_URL}/psy-do-adopcji/`

const MAX_DOG_URLS = 100
const MAX_PHOTOS = 20

export const extractMilanowekDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  const urls = [...document.querySelectorAll('a[href*="/pet/"]')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => !!href && href.includes("/pet/"))
    .map((href) => href.startsWith("http") ? href : `${BASE_URL}${href}`)

  return [...new Set(urls)].slice(0, MAX_DOG_URLS)
}

export const extractMilanowekDogFromDetailPage = (html: string, url: string): RawDogData => {
  const { document } = parseHTML(html)

  // Extract slug from URL
  const slug = url.replace(`${BASE_URL}/pet/`, "").replace(/\/$/, "")
  const externalId = slug

  // Extract name from og:title
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")
  const name = ogTitle?.replace(" - Schronisko Milanówek", "").trim() ?? externalId

  // Extract description from og:description
  const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute("content")
  const rawDescription = ogDescription?.trim() ?? "No description"

  // Extract photos
  const photoUrls: string[] = []

  // Primary photo from og:image
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content")
  if (ogImage) {
    photoUrls.push(ogImage.startsWith("http") ? ogImage : `${BASE_URL}${ogImage}`)
  }

  // Additional photos from gallery (if any)
  const galleryImages = [...document.querySelectorAll('.cmsmasters_img_link img, .project_gallery img')]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => !!src && src.includes("/wp-content/uploads/"))
    .map((src) => (src.startsWith("http") ? src : `${BASE_URL}${src}`))

  photoUrls.push(...galleryImages)

  const photos = [...new Set(photoUrls)].slice(0, MAX_PHOTOS)

  // Extract sex from project details
  let sex: "male" | "female" | "unknown" = "unknown"
  const projectDetails = document.querySelectorAll('.project_details_item')
  for (const item of projectDetails) {
    const titleEl = item.querySelector('.project_details_item_title')
    const descEl = item.querySelector('.project_details_item_desc')
    if (titleEl?.textContent?.includes("Płeć:")) {
      const sexText = descEl?.textContent?.toLowerCase() ?? ""
      if (sexText.includes("pies")) {
        sex = "male"
      } else if (sexText.includes("suka")) {
        sex = "female"
      }
      break
    }
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

export const schroniskoMilanowekAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko w Milanówku",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Milanówek",
  region: "Mazowieckie",

  fetch: (config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(SOURCE_URL).pipe(Effect.scoped)
      return yield* response.text
    }).pipe(
      Effect.mapError((cause) => new ScrapeError({
        shelterId: config.shelterId,
        cause,
        message: `Failed to fetch ${SOURCE_URL}`,
      })),
    ),

  parse: (html, config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const dogUrls = extractMilanowekDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const detailHtml = yield* client.get(url).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            return extractMilanowekDogFromDetailPage(detailHtml, url)
          }).pipe(Effect.catchAll(() => Effect.succeed(null))),
        ),
        { concurrency: 5 },
      )

      return dogs.filter((d) => d !== null) as RawDogData[]
    }).pipe(
      Effect.mapError((cause) => new ParseError({
        shelterId: config.shelterId,
        cause,
        message: "Failed to parse Schronisko Milanówek pages",
      })),
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
