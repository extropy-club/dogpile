import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "przyjaciele-palucha"
const BASE_URL = "https://przyjacielepalucha.pl"
const SOURCE_URL = `${BASE_URL}/psy-do-adopcji/`

const MAX_DOG_URLS = 100
const MAX_DETAIL_PHOTOS = 10
const MAX_DESCRIPTION_NODES = 50

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

const normalizeUrl = (url: string): string | null => {
  try {
    return new URL(url, BASE_URL).toString()
  } catch {
    return null
  }
}

const bestUrlFromSrcset = (srcset: string | null): string | null => {
  if (!srcset) return null

  const candidates = srcset
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

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

const extractDogUrlsFromListHtml = (html: string): readonly string[] => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }
  const links = [...document.querySelectorAll('a[href*="przyjacielepalucha.pl/2"]')].slice(0, 200)

  const urls: string[] = []
  const seen = new Set<string>()

  for (const a of links) {
    const href = a.getAttribute?.("href")
    if (!href) continue
    
    const normalized = normalizeUrl(href)
    if (!normalized) continue
    
    // Match pattern: /YYYY/MM/name/
    const match = normalized.match(/przyjacielepalucha\.pl\/\d{4}\/\d{2}\/[^/]+\/?$/)
    if (!match) continue
    
    // Skip non-dog pages
    if (normalized.includes("/adopcja-") || 
        normalized.includes("/blog/") ||
        normalized.includes("/aktualnosci/")) continue
    
    if (seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
  }

  return urls
}

const extractDogDetails = (html: string, sourceUrl: string): Omit<RawDogData, "fingerprint"> => {
  const { document } = parseHTML(html) as unknown as { document: DocumentLike }

  const externalId = sourceUrl.split("/").filter(Boolean).pop() ?? sourceUrl

  const name = (document.querySelector("h1")?.textContent ?? "Unknown").trim()

  // Extract description from entry-content
  const contentEl = document.querySelector(".entry-content")
  const descriptionNodes = contentEl?.querySelectorAll?.("p")
    ? [...contentEl.querySelectorAll("p")].slice(0, MAX_DESCRIPTION_NODES)
    : []

  const rawDescription = descriptionNodes
    .map((el) => el.textContent?.trim() ?? "")
    .filter((s) => s.length > 0)
    .join("\n")
    .trim()

  // Extract photos from wp-block-image figures
  const photos: string[] = []
  const imageNodes = [
    ...document.querySelectorAll(".wp-block-image img"),
    ...document.querySelectorAll("figure img"),
  ].slice(0, 50)

  for (const img of imageNodes) {
    const bestSrcset = bestUrlFromSrcset(img.getAttribute?.("srcset") ?? null)
    const direct = normalizeUrl(img.getAttribute?.("src") ?? "")
    
    const url = bestSrcset ?? direct
    if (!url) continue
    if (!url.includes("/wp-content/uploads/")) continue
    if (photos.includes(url)) continue
    
    photos.push(url)
    if (photos.length >= MAX_DETAIL_PHOTOS) break
  }

  // Extract tags (age, weight, gender) from article classes
  const article = document.querySelector("article.post")
  const classAttr = article?.getAttribute?.("class") ?? ""
  const tags: string[] = []
  
  const tagMatches = classAttr.match(/tag-[^\s]+/g) ?? []
  for (const tag of tagMatches) {
    // Convert tag-11-lat to "11 lat"
    const cleanTag = tag.replace("tag-", "").replace(/-/g, " ")
    if (cleanTag && !tags.includes(cleanTag)) {
      tags.push(cleanTag)
    }
  }

  // Determine sex from tags
  let sex: "male" | "female" | "unknown" = "unknown"
  if (tags.some(t => t.toLowerCase().includes("samiec"))) {
    sex = "male"
  } else if (tags.some(t => t.toLowerCase().includes("samic"))) {
    sex = "female"
  }

  return {
    externalId,
    name,
    rawDescription,
    photos,
    sex,
    sourceUrl,
  }
}

export const przyjacielePaluchaAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Fundacja Przyjaciele Palucha",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Warszawa",

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
      
      const dogUrls = extractDogUrlsFromListHtml(html).slice(0, MAX_DOG_URLS)

      if (dogUrls.length === 0) {
        return []
      }

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
            message: "Failed to parse Przyjaciele Palucha pages",
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
