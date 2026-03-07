import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "centaurus-folwark"
const BASE_URL = "https://centaurus.org.pl"
const SOURCE_URL = `${BASE_URL}/psy/do-adopcji-realnej`

const MAX_LIST_PAGES = 20
const MAX_DOG_URLS = 500
const MAX_DETAIL_PHOTOS = 30
const MAX_SRCSET_CANDIDATES = 25
const MAX_DESCRIPTION_NODES = 80

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

const listPageUrl = (page: number): string =>
  page === 1
    ? SOURCE_URL
    : `${BASE_URL}/psy/do-adopcji-realnej/page/${page}`

const normalizeUrl = (url: string): string | null => {
  try {
    return new URL(url, BASE_URL).toString()
  } catch {
    return null
  }
}

const isUploadImageUrl = (url: string): boolean => {
  const normalized = normalizeUrl(url)
  if (!normalized) return false

  let pathname = ""
  try {
    pathname = new URL(normalized).pathname.toLowerCase()
  } catch {
    return false
  }

  // Accept WordPress uploads OR Centaurus /images/ paths
  if (!pathname.includes("/wp-content/uploads/") && !pathname.includes("/images/")) return false
  if (pathname.endsWith(".svg")) return false

  return (
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".jpeg") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".webp")
  )
}

const bestUrlFromSrcset = (srcset: string | null): string | null => {
  if (!srcset) return null

  const candidates = srcset
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SRCSET_CANDIDATES)

  let best: { url: string; width: number } | null = null

  for (const entry of candidates) {
    const parts = entry.split(" ").filter(Boolean)
    const url = parts[0] ? normalizeUrl(parts[0]) : null
    if (!url) continue

    const widthToken = parts[1] ?? ""
    const width = widthToken.endsWith("w")
      ? Number.parseInt(widthToken.slice(0, -1))
      : 0
    const safeWidth = Number.isFinite(width) ? width : 0

    if (!best || safeWidth > best.width) best = { url, width: safeWidth }
  }

  return best?.url ?? null
}

const extractMaxPage = (document: DocumentLike): number => {
  const links = [...document.querySelectorAll(".pagination__list a.page-numbers")].slice(0, 200)
  let max = 1

  for (const a of links) {
    const text = a.textContent?.trim() ?? ""
    const fromText = Number.parseInt(text)
    if (Number.isFinite(fromText) && fromText > max) max = fromText

    const href = a.getAttribute?.("href")
    if (!href) continue

    try {
      const pathname = new URL(href, BASE_URL).pathname
      const parts = pathname.split("/").filter(Boolean)
      const idx = parts.indexOf("page")
      const n = idx >= 0 ? Number.parseInt(parts[idx + 1] ?? "") : NaN
      if (Number.isFinite(n) && n > max) max = n
    } catch {
      continue
    }
  }

  return Math.max(1, Math.min(max, MAX_LIST_PAGES))
}

const extractDogUrlsFromListHtml = (html: string): readonly string[] => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }
  const links = [...document.querySelectorAll('a.tile-item[href*="/dog/"]')].slice(0, 2000)

  const urls: string[] = []
  for (const a of links) {
    const href = a.getAttribute?.("href")
    if (!href) continue
    const normalized = normalizeUrl(href)
    if (!normalized) continue
    if (!normalized.startsWith(`${BASE_URL}/dog/`)) continue
    urls.push(normalized)
  }

  return urls
}

const extractDogDetails = (html: string, sourceUrl: string): Omit<RawDogData, "fingerprint"> => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }

  const externalId = sourceUrl.split("/").filter(Boolean).pop() ?? sourceUrl

  const name = (
    document.querySelector("h1.main-title")?.textContent ??
    document.querySelector("h1")?.textContent ??
    "Unknown"
  ).trim()

  const descriptionRoot =
    document.querySelector(".img-text__text") ?? document.querySelector(".wysiwyg") ?? null

  const descriptionNodes =
    descriptionRoot?.querySelectorAll?.("p, li")
      ? [...descriptionRoot.querySelectorAll("p, li")].slice(0, MAX_DESCRIPTION_NODES)
      : []

  const rawDescription = descriptionNodes
    .map((el) => el.textContent?.trim() ?? "")
    .filter((s) => s.length > 0)
    .join("\n")
    .trim()

  const photos: string[] = []
  const imageNodes = [
    ...document.querySelectorAll(".slider-tile-container img"),
    ...document.querySelectorAll("img.wp-post-image"),
  ].slice(0, 200)

  for (const img of imageNodes) {
    const direct =
      normalizeUrl(img.getAttribute?.("src") ?? "") ??
      normalizeUrl(img.getAttribute?.("data-src") ?? "")

    const bestSrcset = bestUrlFromSrcset(img.getAttribute?.("srcset") ?? null)

    const candidates = [bestSrcset, direct].filter((x): x is string => !!x)
    for (const url of candidates) {
      if (!isUploadImageUrl(url)) continue
      if (photos.includes(url)) continue
      photos.push(url)
      if (photos.length >= MAX_DETAIL_PHOTOS) break
    }

    if (photos.length >= MAX_DETAIL_PHOTOS) break
  }

  return {
    externalId,
    name,
    rawDescription,
    photos,
    sex: "unknown",
    sourceUrl,
  }
}

export const centaurusFolwarkAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Fundacja Centaurus",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Wrocław",

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
            message: "Failed to parse Centaurus pages",
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
