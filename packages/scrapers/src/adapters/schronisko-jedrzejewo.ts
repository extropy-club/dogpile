import { Effect } from "effect"
import { HttpClient } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const SHELTER_ID = "schronisko-jedrzejewo"
const BASE_URL = "https://www.sioz.pl"
const SIOZ_SHELTER_ID = "c07b2b18-a6b4-46bc-9cb5-d33660a36a55"
const SOURCE_URL = `${BASE_URL}/OurAnimals?ShelterID=${SIOZ_SHELTER_ID}`

const MAX_DOG_URLS = 250
const MAX_PHOTOS = 20

const toAbsoluteUrl = (href: string): string | null => {
  try {
    const url = new URL(href, BASE_URL)
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

const readQueryParam = (url: string, key: string): string | null => {
  try {
    return new URL(url).searchParams.get(key)
  } catch {
    return null
  }
}

export const extractJedrzejewoDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  // Check if shelter has no animals (TabPanel_NoAnimal tab is present)
  const noAnimalTab = document.querySelector('#MainContent_TabContainer1_TabPanel_NoAnimal')
  if (noAnimalTab) {
    // Shelter has no dogs currently
    return []
  }

  const urls = [...document.querySelectorAll('a[href*="DetailsOfTheAnimal.aspx"]')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => typeof href === "string" && href.length > 0)
    .map((href) => toAbsoluteUrl(href))
    .filter((u): u is string => typeof u === "string")
    .filter((u) => readQueryParam(u, "ShelterID") === SIOZ_SHELTER_ID)

  return [...new Set(urls)].slice(0, MAX_DOG_URLS)
}

const parseSex = (text: string): "male" | "female" | "unknown" => {
  const lower = text.toLowerCase()
  if (lower.includes("płeć") && lower.includes("suka")) return "female"
  if (lower.includes("płeć") && (lower.includes("pies") || lower.includes("kocur"))) return "male"
  if (lower.includes("suka")) return "female"
  if (lower.includes("pies") || lower.includes("kocur")) return "male"
  return "unknown"
}

export const extractJedrzejewoDogFromDetailPage = (html: string, url: string): RawDogData => {
  const { document } = parseHTML(html)

  const externalId = readQueryParam(url, "AnimalID") ?? url

  const headerCandidates = [...document.querySelectorAll("h1")]
    .map((h) => h.textContent?.trim() ?? "")
    .filter((s) => s.length > 0 && !s.toLowerCase().startsWith("id:"))

  const name = headerCandidates.at(-1) ?? externalId

  const descriptionLines = [...document.querySelectorAll("li.two ul li")]
    .map((li) => li.textContent?.trim() ?? "")
    .filter((s) => s.length > 0)

  const rawDescription = descriptionLines.join("\n") || "No description"

  const sex = parseSex(rawDescription)

  const photos = [
    ...new Set(
      [...document.querySelectorAll('input[type="image"][src*="GetMedia.ashx"]')]
        .map((img) => img.getAttribute("src"))
        .filter((src): src is string => typeof src === "string" && src.length > 0),
    ),
  ]
    .slice(0, MAX_PHOTOS)

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

export const schroniskoJedrzejewoAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Schronisko w Jędrzejewie",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Jędrzejewo",
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
      })),
    ),

  parse: (html, config) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const dogUrls = extractJedrzejewoDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          client.get(url).pipe(
            Effect.flatMap((res) => res.text),
            Effect.scoped,
            Effect.map((detailHtml) => extractJedrzejewoDogFromDetailPage(detailHtml, url)),
            Effect.catchAll(() => Effect.succeed(null)),
          ),
        ),
        { concurrency: 5 },
      )

      return dogs.filter((d) => d !== null) as RawDogData[]
    }).pipe(
      Effect.mapError((cause) => new ParseError({
        shelterId: config.shelterId,
        cause,
        message: "Failed to parse Schronisko Jędrzejewo pages",
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
