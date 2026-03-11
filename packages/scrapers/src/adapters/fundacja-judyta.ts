import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { parseHTML } from "linkedom"
import { createAdapter, type RawDogData } from "../adapter.js"
import { ScrapeError, ParseError } from "@dogpile/core"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SHELTER_ID = "fundacja-judyta"
const BASE_URL = "https://fundacjajudyta.com"
const SOURCE_URL = `${BASE_URL}/adopcje/`

const MAX_DOG_URLS = 100

const isPhotoUrl = (url: string): boolean =>
  /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)

const extractJudytaDogUrlsFromListing = (html: string): readonly string[] => {
  const { document } = parseHTML(html)

  const urls = [...document.querySelectorAll('a')]
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => !!href)
    .filter((href) => {
      // Filter out navigation, media, and other non-dog URLs
      const skipPatterns = [
        '/adopcje/',
        '/adopcje#',
        '/domy-tymczasowe',
        '/niepelnosprytki',
        '/kontakt',
        '/wesprzyj',
        '/15-procent-podatku',
        '/szczeniaki',
        '/feed/',
        '/wp-content/',
        '/wp-includes/',
        '/wp-json/',
        'wp-admin',
        'mailto:',
        'tel:',
        'facebook.com',
        'youtube.com',
        'instagram.com',
        'forms.gle',
      ]
      
      if (skipPatterns.some(pattern => href.toLowerCase().includes(pattern.toLowerCase()))) {
        return false
      }
      
      // Include absolute URLs to individual dog pages
      if (href.startsWith("https://fundacjajudyta.com/")) {
        const path = href.replace("https://fundacjajudyta.com/", "")
        return path && path !== "" && !path.includes("/")
      }
      
      // Include relative URLs that look like dog names
      if (href.startsWith("/")) {
        const path = href.slice(1)
        return path && path !== "" && !path.includes("/")
      }
      
      return false
    })
    .map((href) => (href.startsWith("http") ? href : `${BASE_URL}${href}`))

  return [...new Set(urls)].slice(0, MAX_DOG_URLS)
}

const parseAgeFromText = (text: string): number | null => {
  // Parse birth year format like "02/2021" or "Rok urodzenia: 07/2022"
  const birthYearMatch = text.match(/(\d{2})\/(\d{4})/)
  if (birthYearMatch) {
    const year = parseInt(birthYearMatch[2], 10)
    const currentYear = new Date().getFullYear()
    return (currentYear - year) * 12
  }
  
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

export const extractJudytaDogFromDetailPage = (html: string, url: string): RawDogData => {
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

  // Parse info table - Judyta uses a table with alternating rows
  const infoMap = new Map<string, string>()
  
  // Look for the data rows in the Elementor widget
  const allElements = [...document.querySelectorAll('*')]
  
  // Judyta site uses a structure with label-value pairs
  // Look for text that contains the labels we expect
  const pageText = document.body?.textContent ?? ""
  
  // Try to extract from table structure first
  const tableRows = [...document.querySelectorAll('tr, .elementor-row')]
  tableRows.forEach(row => {
    const cells = [...row.querySelectorAll('td, .elementor-column')]
    if (cells.length >= 2) {
      const label = cells[0]?.textContent?.trim().toLowerCase() ?? ""
      const value = cells[1]?.textContent?.trim() ?? ""
      if (label && value) {
        infoMap.set(label, value)
      }
    }
  })
  
  // Also try parsing from lists
  const listItems = [...document.querySelectorAll('li, .elementor-icon-list-item')]
  listItems.forEach(item => {
    const text = item.textContent?.trim() ?? ""
    if (text.includes(":")) {
      const [key, value] = text.split(":", 2)
      if (key && value) {
        infoMap.set(key.trim().toLowerCase(), value.trim())
      }
    }
  })

  // Get sex from info map or parse from page text
  let sex: "male" | "female" | "unknown" = "unknown"
  const sexValue = infoMap.get("płeć") || infoMap.get("plec")
  if (sexValue) {
    if (sexValue.toLowerCase().includes("pies") || sexValue.toLowerCase().includes("samiec")) {
      sex = "male"
    } else if (sexValue.toLowerCase().includes("suka") || sexValue.toLowerCase().includes("samica")) {
      sex = "female"
    }
  } else if (pageText.toLowerCase().includes("pies") || pageText.toLowerCase().includes("samiec")) {
    sex = "male"
  } else if (pageText.toLowerCase().includes("suka") || pageText.toLowerCase().includes("samica")) {
    sex = "female"
  }

  // Get age from "wiek" field
  const ageText = infoMap.get("wiek") || ""
  let ageMonths: number | null = parseAgeFromText(ageText)

  // Get weight
  const weightText = infoMap.get("waga") || ""
  const weightKg: number | null = parseWeightFromText(weightText)

  // Determine size from weight
  let size: "small" | "medium" | "large" | null = null
  if (weightKg !== null) {
    if (weightKg < 10) size = "small"
    else if (weightKg < 25) size = "medium"
    else size = "large"
  }
  
  // Also check "docelowy wzrost" field
  const wzrostText = infoMap.get("docelowy wzrost") || ""
  if (wzrostText.toLowerCase().includes("mał")) size = "small"
  else if (wzrostText.toLowerCase().includes("średn")) size = "medium"
  else if (wzrostText.toLowerCase().includes("duż")) size = "large"

  // Get description - find the main content area
  // Judyta uses Elementor with specific classes
  const contentSelectors = [
    '.elementor-widget-text-editor',
    '.entry-content',
    'article',
    '.post-content',
    '[data-widget_type="text-editor.default"]'
  ]
  
  let rawDescription = "No description"
  for (const selector of contentSelectors) {
    const el = document.querySelector(selector)
    if (el) {
      const paragraphs = [...el.querySelectorAll("p")]
        .map((p) => p.textContent?.trim())
        .filter((text): text is string => !!text && text.length > 0)
      
      if (paragraphs.length > 0) {
        rawDescription = paragraphs.join("\n\n")
        break
      }
    }
  }
  
  // If still no description, try to get from the body content
  if (rawDescription === "No description") {
    const bodyText = document.body?.textContent ?? ""
    // Look for text after "Status: do adopcji" or similar markers
    const match = bodyText.match(/Status:.*?do adopcji(.+)/s)
    if (match) {
      rawDescription = match[1].trim().substring(0, 1000)
    }
  }

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
    breed: null,
    ageMonths,
    size,
    sourceUrl: url,
  }
}

export const fundacjaJudytaAdapter = createAdapter({
  id: SHELTER_ID,
  name: "Fundacja dla Szczeniąt Judyta",
  url: BASE_URL,
  sourceUrl: SOURCE_URL,
  city: "Nowa Sucha",
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
      const dogUrls = extractJudytaDogUrlsFromListing(html)

      const dogs = yield* Effect.all(
        dogUrls.map((url) =>
          Effect.gen(function* () {
            const request = HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader("User-Agent", USER_AGENT)
            )
            const detailHtml = yield* client.execute(request).pipe(Effect.flatMap((r) => r.text), Effect.scoped)
            return extractJudytaDogFromDetailPage(detailHtml, url)
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
            message: "Failed to parse Fundacja Judyta pages",
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
