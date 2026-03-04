import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "schronisko-leszno-henrykowo"
// Using HTTP instead of HTTPS due to incomplete SSL certificate chain
// The site has certificate verification issues that prevent HTTPS fetching
const BASE_URL = "http://schronisko.leszno.pl"
const SOURCE_URL = `${BASE_URL}/adopcje/psy-do-adopcji/`

const MAX_LISTING_PAGES = 10
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

export const extractLesznoHenrykowoDogUrlsFromListing = (html: string): readonly string[] => {
  const document = parseDocument(html)
  const urls = new Set<string>()

  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => typeof href === "string")
    // Exclude JavaScript and anchor links
    .filter((href) => !href.startsWith("javascript:") && !href.startsWith("#"))
    // Convert relative URLs to absolute
    .map((href) => {
      if (href.startsWith("http")) return href
      // Handle relative URLs
      if (href.startsWith("/")) return `${BASE_URL}${href}`
      return `${BASE_URL}/${href}`
    })
    .filter((href) =>
      (href.startsWith("http://schronisko.leszno.pl/") || href.startsWith("https://schronisko.leszno.pl/")) &&
      !href.includes("/category/") &&
      !href.includes("/adopcje/") &&
      !href.includes("/aktualnosci/") &&
      !href.includes("/kontakt") &&
      !href.includes("/edukacja") &&
      !href.includes("/wolontariat") &&
      !href.includes("/galeria") &&
      !href.includes("/w-nowym-domku") &&
      !href.includes("/za-teczowym-mostem") &&
      !href.includes("/nowi-w-schronisku") &&
      !href.includes("wp-content") &&
      !href.includes("facebook") &&
      !href.includes("youtube")
    )

  for (const href of links) {
    if (urls.size >= MAX_DOGS) break
    // Normalize to http:// for consistency
    const normalizedHref = href.replace("https://schronisko.leszno.pl", "http://schronisko.leszno.pl")
    const slug = normalizedHref.replace(BASE_URL, "").replace(/^\//, "").replace(/\/$/, "")
    if (slug && !slug.includes("/") && slug.length > 1 && slug.length < 100) {
      urls.add(normalizedHref.replace(/\/$/, "") + "/")
    }
  }
  return [...urls]
}

export const extractLesznoHenrykowoDogFromDetailPage = (html: string, url: string): RawDogData => {
  const document = parseDocument(html)

  const slug = url.replace(BASE_URL, "").replace(/^\//, "").replace(/\/$/, "")
  const externalId = slug || (url.split("/").filter(Boolean).pop() ?? url)

  const h1 = document.querySelector("h1")
  const name = h1?.textContent?.trim() ?? externalId

  const contentDivs = [...document.querySelectorAll(".entry-content p, article p, .post-content p")]
    .map((p) => p.textContent?.trim() ?? "")
    .filter((t) =>
      t.length > 10 &&
      !t.includes("cookie") &&
      !t.includes("Rozumiem i akceptuję")
    )

  const rawDescription = contentDivs.join("\n").slice(0, 5000)

  const categoryLinks = [...document.querySelectorAll('a[href*="/category/"]')]
    .map((a) => a.textContent?.toLowerCase() ?? "")

  let sex: "male" | "female" | "unknown" = "unknown"
  if (categoryLinks.some((c) => c.includes("psiaki"))) {
    sex = "male"
  } else if (categoryLinks.some((c) => c.includes("sunie"))) {
    sex = "female"
  }

  const photos = [...new Set(
    [...document.querySelectorAll('img[src*="/wp-content/uploads/"]')]
      .map((img) => img.getAttribute("src"))
      .filter((src): src is string =>
        typeof src === "string" &&
        src.includes("/wp-content/uploads/") &&
        !src.includes("facebook-icon") &&
        !src.includes("youtube-logo") &&
        !src.includes("SCHRONISKO_przezr")
      )
  )].slice(0, MAX_PHOTOS)

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

const extractMaxListingPage = (document: DomDocument): number => {
  const pageLinks = [...document.querySelectorAll('a.page-numbers[href]')]
    .map((a) => a.textContent?.trim())
    .filter((text): text is string => typeof text === "string")

  const pageNumbers = pageLinks
    .map((text) => parseInt(text, 10))
    .filter((n) => Number.isFinite(n) && n > 0)

  const maxPage = pageNumbers.reduce((max, n) => Math.max(max, n), 1)
  return Math.min(MAX_LISTING_PAGES, maxPage)
}

export const schroniskoLesznoHenrykowoAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko dla Zwierząt w Henrykowie (Leszno)",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Leszno",
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

      const firstDoc = parseDocument(html)
      const maxPage = extractMaxListingPage(firstDoc)

      const extraListingUrls = Array.from(
        { length: Math.max(0, maxPage - 1) },
        (_, i) => `${SOURCE_URL}page/${i + 2}/`,
      )

      const extraListingPages = yield* Effect.all(
        extraListingUrls.map((url) =>
          client.get(url).pipe(
            Effect.flatMap((res) => res.text),
            Effect.scoped,
            Effect.catchAll(() => Effect.succeed("")),
          )
        ),
        { concurrency: 3 }
      )

      const listingPages = [html, ...extraListingPages]

      const dogUrls = [
        ...new Set(
          listingPages.flatMap((pageHtml) => {
            if (pageHtml.length === 0) return []
            return extractLesznoHenrykowoDogUrlsFromListing(pageHtml)
          })
        ),
      ].slice(0, MAX_DOGS)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          client.get(url).pipe(
            Effect.flatMap((res) => res.text),
            Effect.scoped,
            Effect.map((detailHtml) => extractLesznoHenrykowoDogFromDetailPage(detailHtml, url)),
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
        message: "Failed to parse Schronisko Leszno Henrykowo pages",
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
