import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "schronisko-ostrow"
const BASE_URL = "https://schroniskoostrow.pl"
const SOURCE_URL = `${BASE_URL}/adopcja-psy`

const MAX_DOGS = 150
const MAX_PHOTOS = 20

type DomElement = {
  readonly textContent: string | null
  readonly getAttribute: (name: string) => string | null
  readonly querySelectorAll: (selectors: string) => Iterable<DomElement>
  readonly querySelector: (selectors: string) => DomElement | null
}

type DomDocument = DomElement & {
  readonly body: DomElement
}

const parseDocument = (html: string): DomDocument => {
  const parsed = parseHTML(html) as unknown as { document?: unknown }
  const doc = parsed.document as DomDocument
  if (!doc || typeof doc.querySelector !== "function") {
    throw new Error("Invalid HTML document")
  }
  return doc
}

export const extractOstrowDogUrlsFromListing = (html: string): readonly string[] => {
  const document = parseDocument(html)
  const urls = new Set<string>()

  // Known navigation paths to exclude
  const excludedPaths = [
    "", "/", "/o-nas", "/adopcja-psy", "/adopcje-psy", "/znalazles-psa",
    "/wolnozyjace-koty", "/zwierze-po-wypadku", "/dzikie-zwierze", "/kontakt",
    "/files", "/lib"
  ]

  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => typeof href === "string")
    // Convert relative URLs to absolute
    .map((href) => href.startsWith("http") ? href : `${BASE_URL}${href}`)
    .filter((href) =>
      href.startsWith(BASE_URL + "/") &&
      !href.includes("facebook") &&
      !href.includes("instagram") &&
      !href.includes("google")
    )

  for (const href of links) {
    if (urls.size >= MAX_DOGS) break
    const slug = href.replace(BASE_URL, "").replace(/^\//, "").replace(/\/$/, "")
    // Dog pages are single-word slugs not in excluded list
    if (slug && 
        !slug.includes("/") && 
        !excludedPaths.includes("/" + slug) &&
        slug.length > 1 && 
        slug.length < 50) {
      urls.add(href.replace(/\/$/, ""))
    }
  }
  return [...urls]
}

export const extractOstrowDogFromDetailPage = (html: string, url: string): RawDogData => {
  const document = parseDocument(html)

  const slug = url.replace(BASE_URL, "").replace(/^\//, "").replace(/\/$/, "")
  const externalId = slug || (url.split("/").filter(Boolean).pop() ?? url)

  const h1 = document.querySelector("h1")
  const name = h1?.textContent?.trim() ?? externalId

  const paragraphs = [...document.querySelectorAll("p, div")]
    .map((p) => p.textContent?.trim() ?? "")
    .filter((t) =>
      t.length > 30 &&
      !t.includes("WebWave") &&
      !t.includes("cookie") &&
      !t.includes("537-830-730")
    )

  const rawDescription = paragraphs.join("\n").slice(0, 5000)

  const sexMatch = rawDescription.toLowerCase()
  const sex = sexMatch.includes("samiec") || sexMatch.includes("pies:") ? "male" as const
    : sexMatch.includes("samica") || sexMatch.includes("suka") ? "female" as const
    : "unknown" as const

  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content")
  const photos = ogImage ? [ogImage] : []

  return {
    fingerprint: `${SHELTER_ID}:${externalId}`,
    externalId,
    name,
    rawDescription,
    photos: photos.slice(0, MAX_PHOTOS),
    sex,
    sourceUrl: url,
  }
}

export const schroniskoOstrowAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko Pod Wiatrakami w Ostrowie Wielkopolskim",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Ostrów Wielkopolski",
  region: "Wielkopolskie",

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
      }))
    ),

  parse: (html, config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const dogUrls = extractOstrowDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          client.get(url).pipe(
            Effect.flatMap((res) => res.text),
            Effect.scoped,
            Effect.map((detailHtml) => extractOstrowDogFromDetailPage(detailHtml, url)),
            Effect.catchAll(() => Effect.succeed(null)),
          )
        ),
        { concurrency: 5 }
      )

      return dogs.filter((d) => d !== null) as RawDogData[]
    }).pipe(
      Effect.mapError((cause) => new ParseError({
        shelterId: config.shelterId,
        cause,
        message: "Failed to parse Schronisko Ostrów pages",
      }))
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
