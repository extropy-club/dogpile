import { Effect } from "effect"
import { drizzle } from "drizzle-orm/d1"
import { dogs, shelters, syncLogs, apiCosts } from "@dogpile/db"
import { makeEnvelope, type ImagesProcessOriginalJob, type PhotosGenerateJob } from "@dogpile/core/queues"
import { eq, desc, asc, and, like, sql, SQL, inArray } from "drizzle-orm"
import { DatabaseError, R2Error, QueueError } from "./errors"

interface Env {
  DB: D1Database
  KV: KVNamespace
  PHOTOS_ORIGINAL: R2Bucket
  PHOTOS_GENERATED: R2Bucket
  VECTORIZE: VectorizeIndex
  OPENROUTER_API_KEY: string
  OPENROUTER_MODEL: string
  ENVIRONMENT: string
  R2_PUBLIC_DOMAIN?: string
  IMAGE_QUEUE?: Queue<ImagesProcessOriginalJob | { dogId: string; urls: string[] }>
  PHOTO_GEN_QUEUE?: Queue<PhotosGenerateJob>
  REINDEX_QUEUE?: Queue<any>
  SCRAPE_QUEUE?: Queue<{ shelterId: string; shelterSlug: string; baseUrl: string; syncLogId?: string }>
  ADMIN_KEY?: string
}

/**
 * TODO: Centralize ReindexJob type to avoid duplication
 */
interface ReindexJob {
  type: "upsert" | "delete" | "regenerate-bio"
  dogId: string
  description?: string
  metadata?: {
    shelterId?: string
    city?: string | undefined
    size?: string
    ageMonths?: number
    sex?: string | undefined
  }
}

type ApiError = DatabaseError | R2Error | QueueError

const isAuthorized = (req: Request, env: Env): boolean => {
  const auth = req.headers.get("Authorization")
  return !!(env.ADMIN_KEY && auth === `Bearer ${env.ADMIN_KEY}`)
}

const toIsoTimestamp = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()

  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(raw)) return null

  // Some historic rows stored seconds; current schema uses ms.
  const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function buildSearchText(dog: any): string {
  const parts: string[] = [`Pies ${dog.name}`]
  
  if (dog.ageEstimate?.months) {
    const months = dog.ageEstimate.months
    if (months < 12) {
      parts.push(`szczeniak ${months} miesięcy`)
    } else {
      const years = Math.floor(months / 12)
      parts.push(`${years} ${years === 1 ? 'rok' : years < 5 ? 'lata' : 'lat'}`)
    }
  }
  
  if (dog.sizeEstimate?.value) {
    const sizeMap: Record<string, string> = { small: "mały pies", medium: "średni pies", large: "duży pies" }
    parts.push(sizeMap[dog.sizeEstimate.value] || dog.sizeEstimate.value)
  }
  
  if (dog.breedEstimates?.length) {
    parts.push(`rasa ${dog.breedEstimates[0].breed.replace(/_/g, " ")}`)
  }
  
  if (dog.locationCity) parts.push(`z miasta ${dog.locationCity}`)
  if (dog.sex === "male") parts.push("samiec")
  if (dog.sex === "female") parts.push("samica")
  if (dog.personalityTags?.length) parts.push(dog.personalityTags.join(", "))
  if (dog.generatedBio) parts.push(dog.generatedBio)
  
  return parts.join(". ")
}

type RouteHandler = (
  request: Request,
  env: Env,
  params: Record<string, string>,
  ctx: ExecutionContext
) => Effect.Effect<Response, ApiError, never>

interface Route {
  method: string
  pattern: URLPattern
  handler: RouteHandler
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // Cache preflight results to reduce noisy OPTIONS spam in dev (and improve UX in general).
  "Access-Control-Max-Age": "86400",
}

const json = (data: unknown, status = 200) => {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  })
  return Effect.succeed(response)
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/health" }),
    handler: Effect.fn("api.health")(() => json({ status: "ok", timestamp: new Date().toISOString() })),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/admin/jobs" }),
    handler: Effect.fn("api.adminJobs")(function* (req, env) {
      if (!isAuthorized(req, env)) {
        return yield* json({ error: "Unauthorized" }, 401)
      }

      const url = new URL(req.url)
      const limitParam = url.searchParams.get("limit")
      const limit = Math.min(Math.max(parseInt(limitParam ?? "50") || 50, 1), 200)

      const db = drizzle(env.DB)

      // GC: if a worker crashes mid-flight, we can end up with "running" jobs forever.
      // There's no reliable way to introspect queue state, so we treat old "running" jobs as failed.
      const STALE_AFTER_MS = 2 * 60 * 60 * 1000
      const nowMs = Date.now()
      const staleBeforeMs = nowMs - STALE_AFTER_MS
      const staleBeforeSec = Math.floor(staleBeforeMs / 1000)
      const finishedMs = nowMs
      const finishedSec = Math.floor(finishedMs / 1000)
      const staleErrorMessage = "Stale job timeout (no worker completion)"
      const staleErrorsJson = JSON.stringify([staleErrorMessage])

      const gcSeconds = Effect.tryPromise({
        try: () =>
          env.DB.prepare(
            `UPDATE sync_logs
             SET finished_at = ?, errors = ?, error_message = ?
             WHERE finished_at IS NULL AND started_at < 1000000000000 AND started_at < ?`
          )
            .bind(finishedSec, staleErrorsJson, staleErrorMessage, staleBeforeSec)
            .run(),
        catch: (e) => new DatabaseError({ operation: "gc stale jobs (seconds)", cause: e }),
      })

      const gcMillis = Effect.tryPromise({
        try: () =>
          env.DB.prepare(
            `UPDATE sync_logs
             SET finished_at = ?, errors = ?, error_message = ?
             WHERE finished_at IS NULL AND started_at >= 1000000000000 AND started_at < ?`
          )
            .bind(finishedMs, staleErrorsJson, staleErrorMessage, staleBeforeMs)
            .run(),
        catch: (e) => new DatabaseError({ operation: "gc stale jobs (ms)", cause: e }),
      })

      yield* Effect.zipRight(gcSeconds, gcMillis).pipe(Effect.catchAll(() => Effect.void))

      const logs = yield* Effect.tryPromise({
        try: () =>
          db.select({
            id: syncLogs.id,
            shelterId: syncLogs.shelterId,
            shelterName: shelters.name,
            startedAt: syncLogs.startedAt,
            finishedAt: syncLogs.finishedAt,
            dogsAdded: syncLogs.dogsAdded,
            dogsUpdated: syncLogs.dogsUpdated,
            dogsRemoved: syncLogs.dogsRemoved,
            errors: syncLogs.errors,
            errorMessage: syncLogs.errorMessage,
          })
          .from(syncLogs)
          .leftJoin(shelters, eq(syncLogs.shelterId, shelters.id))
          .orderBy(desc(syncLogs.startedAt))
          .limit(limit)
          .all(),
        catch: (e) => new DatabaseError({ operation: "get admin jobs", cause: e })
      })

      const jobs = logs.map(log => {
        let status: "running" | "error" | "success"
        if (!log.finishedAt) {
          status = "running"
        } else if (log.errorMessage || (log.errors && log.errors.length > 0)) {
          status = "error"
        } else {
          status = "success"
        }

        return {
          id: log.id,
          shelterId: log.shelterId,
          shelterName: log.shelterName ?? "Unknown",
          startedAt: toIsoTimestamp(log.startedAt),
          finishedAt: toIsoTimestamp(log.finishedAt),
          dogsAdded: log.dogsAdded,
          dogsUpdated: log.dogsUpdated,
          dogsRemoved: log.dogsRemoved,
          errors: log.errors ?? [],
          errorMessage: log.errorMessage,
          status,
        }
      })

      return yield* json({ jobs })
    }),
  },
  {
    method: "POST",
    pattern: new URLPattern({ pathname: "/admin/jobs/:id/cancel" }),
    handler: Effect.fn("api.adminCancelJob")(function* (req, env, params) {
      if (!isAuthorized(req, env)) {
        return yield* json({ error: "Unauthorized" }, 401)
      }

      const body = yield* Effect.tryPromise({
        try: async () => (await req.json().catch(() => ({}))) as { reason?: string },
        catch: (e) => new DatabaseError({ operation: "parseBody(adminCancelJob)", cause: e }),
      })

      const reason = (body.reason ?? "Canceled by admin").trim() || "Canceled by admin"

      const db = drizzle(env.DB)
      const existing = yield* Effect.tryPromise({
        try: () => db.select().from(syncLogs).where(eq(syncLogs.id, params.id)).get(),
        catch: (e) => new DatabaseError({ operation: "getJob(adminCancelJob)", cause: e }),
      })

      if (!existing) return yield* json({ error: "Job not found" }, 404)
      if (existing.finishedAt) return yield* json({ success: true, message: "Job already finished" })

      yield* Effect.tryPromise({
        try: () =>
          db.update(syncLogs)
            .set({
              finishedAt: new Date(),
              errors: [reason],
              errorMessage: reason,
            })
            .where(eq(syncLogs.id, params.id))
            .run(),
        catch: (e) => new DatabaseError({ operation: "cancelJob(adminCancelJob)", cause: e }),
      })

      return yield* json({ success: true })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/dogs" }),
    handler: Effect.fn("api.listDogs")(function* (req, env) {
      const url = new URL(req.url)
      const db = drizzle(env.DB)
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20") || 20, 1), 100)
      const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0") || 0, 0)
      const statusParam = url.searchParams.get("status")
      const city = url.searchParams.get("city")
      const sex = url.searchParams.get("sex")
      const size = url.searchParams.get("size")
      const idsParam = url.searchParams.get("ids")

      const filters: SQL[] = []

      // Only allow available dogs in public API
      if (statusParam && statusParam !== "available") {
        return yield* json({ dogs: [], total: 0 })
      }
      
      filters.push(eq(dogs.status, "available"))

      if (idsParam) {
        const ids = idsParam.split(",").filter(id => id.trim().length > 0)
        if (ids.length > 0) {
          filters.push(inArray(dogs.id, ids))
        }
      }

      if (city) {
        filters.push(sql`lower(${dogs.locationCity}) = lower(${city})`)
      }
      if (sex && ["male", "female", "unknown"].includes(sex)) {
        filters.push(eq(dogs.sex, sex as any))
      }
      if (size) {
        filters.push(sql`lower(json_extract(${dogs.sizeEstimate}, '$.value')) = lower(${size})`)
      }
      
      const tag = url.searchParams.get("tag")
      if (tag) {
        filters.push(sql`lower(json_extract(${dogs.personalityTags}, '$')) LIKE lower(${'%' + tag + '%'})`)
      }

      const results = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(dogs)
            .where(filters.length > 0 ? and(...filters) : undefined)
            .orderBy(desc(dogs.createdAt))
            .limit(limit)
            .offset(offset)
            .all(),
        catch: (e) => new DatabaseError({ operation: "listDogs", cause: e })
      })

      return yield* json({ dogs: results ?? [], total: results?.length ?? 0 })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/dogs/random" }),
    handler: Effect.fn("api.getRandomDog")(function* (_req, env) {
      const db = drizzle(env.DB)
      
      const result = yield* Effect.tryPromise({
        try: () => 
          db.select()
            .from(dogs)
            .where(eq(dogs.status, "available"))
            .orderBy(sql`RANDOM()`)
            .limit(1)
            .get(),
        catch: (e) => new DatabaseError({ operation: "getRandomDog", cause: e })
      })
      
      if (!result) {
        return yield* json({ error: "No dogs found" }, 404)
      }
      
      const { fingerprint, ...publicData } = result as any
      return yield* json(publicData)
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/dogs/search" }),

   handler: Effect.fn("api.searchDogs")(function* (req, env) {
   const url = new URL(req.url)
   const query = url.searchParams.get("q")
   if (!query) {
     return yield* json({ error: "Missing q parameter" }, 400)
   }
   
   const city = url.searchParams.get("city")
   const size = url.searchParams.get("size")
   const sex = url.searchParams.get("sex")
   const parsedLimit = parseInt(url.searchParams.get("limit") || "10")
   const limit = Math.min(isNaN(parsedLimit) ? 10 : parsedLimit, 50)

   // Get embedding for query
   const embedding = yield* Effect.tryPromise({
     try: async () => {
       const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
         method: "POST",
         headers: {
           "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
           "Content-Type": "application/json",
         },
         body: JSON.stringify({
           model: env.OPENROUTER_MODEL,
           input: [query],
         }),
       })
       const data = await response.json() as { data: [{ embedding: number[] }] }
       return data.data[0].embedding
     },
     catch: (e) => new DatabaseError({ operation: "get embedding", cause: e })
   })

   // Build metadata filter
   const filter: Record<string, string> = {}
   if (city) filter.city = city
   if (size) filter.size = size
   if (sex) filter.sex = sex

   // TODO: Add age range filtering when Vectorize supports numeric comparisons

   // Search Vectorize
   const results = yield* Effect.tryPromise({
     try: () => {
       const options: VectorizeQueryOptions = {
         topK: limit,
       }
       if (Object.keys(filter).length > 0) {
         options.filter = filter
       }
       return env.VECTORIZE.query(embedding, options)
     },
     catch: (e) => new DatabaseError({ operation: "vector search", cause: e })
   })

   // Hydrate from D1
   const db = drizzle(env.DB)
   const ids = results.matches.map(m => m.id)
   
   if (ids.length === 0) {
     return yield* json({ dogs: [], scores: [] })
   }

   const dogResults = yield* Effect.tryPromise({
     try: () => db.select().from(dogs).where(and(inArray(dogs.id, ids), eq(dogs.status, "available"))).all(),
     catch: (e) => new DatabaseError({ operation: "hydrate dogs", cause: e })
   })

   // Sort by vector score
   const scoreMap = new Map(results.matches.map(m => [m.id, m.score]))
   dogResults.sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0))

     // Remove fingerprint from response
     const publicDogs = dogResults.map(({ fingerprint, ...rest }) => rest)

     return yield* json({
       dogs: publicDogs,
       scores: dogResults.map(d => scoreMap.get(d.id) || 0)
     })
   }),
 },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/dogs/:id" }),
    handler: Effect.fn("api.getPublicDog")(function* (_req, env, params) {
      const db = drizzle(env.DB)
      const result = yield* Effect.tryPromise({
        try: () => db.select({
          id: dogs.id,
          shelterId: dogs.shelterId,
          externalId: dogs.externalId,
          name: dogs.name,
          sex: dogs.sex,
          locationName: dogs.locationName,
          locationCity: dogs.locationCity,
          locationLat: dogs.locationLat,
          locationLng: dogs.locationLng,
          isFoster: dogs.isFoster,
          breedEstimates: dogs.breedEstimates,
          sizeEstimate: dogs.sizeEstimate,
          ageEstimate: dogs.ageEstimate,
          weightEstimate: dogs.weightEstimate,
          personalityTags: dogs.personalityTags,
          vaccinated: dogs.vaccinated,
          sterilized: dogs.sterilized,
          chipped: dogs.chipped,
          furLength: dogs.furLength,
          furType: dogs.furType,
          colorPrimary: dogs.colorPrimary,
          colorSecondary: dogs.colorSecondary,
          colorPattern: dogs.colorPattern,
          earType: dogs.earType,
          tailType: dogs.tailType,
          photos: dogs.photos,
          photosGenerated: dogs.photosGenerated,
          sourceUrl: dogs.sourceUrl,
          urgent: dogs.urgent,
          status: dogs.status,
          rawDescription: dogs.rawDescription,
          generatedBio: dogs.generatedBio,
          lastSeenAt: dogs.lastSeenAt,
          createdAt: dogs.createdAt,
          updatedAt: dogs.updatedAt,
        }).from(shelters)
        .leftJoin(dogs, eq(shelters.id, dogs.shelterId))
        .where(eq(dogs.id, params.id))
        .get(),
        catch: (e) => new DatabaseError({ operation: "getPublicDog", cause: e })
      })
       
      if (!result || result.status !== "available") {
        return yield* json({ error: "Dog not found" }, 404)
      }
       
      const { fingerprint, ...publicData } = result as any

      // Add shelter name from joined query
      if (publicData?.shelters?.name) {
        publicData.shelterName = publicData.shelters.name
      }

      return yield* json(publicData)
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/admin/stats" }),
    handler: Effect.fn("api.adminStats")(function* (req, env) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const db = drizzle(env.DB)

      const dogStats = yield* Effect.tryPromise({
        try: () => db.select({ status: dogs.status, count: sql<number>`count(*)` }).from(dogs).groupBy(dogs.status).all(),
        catch: (e) => new DatabaseError({ operation: "dogStats", cause: e })
      })

      const shelterData = yield* Effect.tryPromise({
        try: () => db.select({
          id: shelters.id,
          name: shelters.name,
          slug: shelters.slug,
          active: shelters.active,
          status: shelters.status,
          lastSync: shelters.lastSync,
          dogCount: sql<number>`count(${dogs.id})`
        })
        .from(shelters)
        .leftJoin(dogs, eq(shelters.id, dogs.shelterId))
        .groupBy(shelters.id)
        .all(),
        catch: (e) => new DatabaseError({ operation: "shelterStats", cause: e })
      })

      // Get latest sync log errors for all shelters in one query
      const latestLogs = yield* Effect.tryPromise({
        try: () => env.DB.prepare(`
          SELECT sl.shelter_id, sl.errors, sl.error_message, sl.started_at, sl.finished_at
          FROM sync_logs sl
          INNER JOIN (
            SELECT shelter_id, MAX(started_at) as max_at
            FROM sync_logs
            GROUP BY shelter_id
          ) latest ON sl.shelter_id = latest.shelter_id AND sl.started_at = latest.max_at
        `).all(),
        catch: (e) => new DatabaseError({ operation: "batchLatestErrors", cause: e })
      })

      const errorMap = new Map<string, string | null>()
      const startedAtMap = new Map<string, string | null>()
      const finishedAtMap = new Map<string, string | null>()

      for (const row of (latestLogs.results || []) as { shelter_id: string; errors: unknown; error_message: unknown; started_at: unknown; finished_at: unknown }[]) {
        const rawMessage = row.error_message

        if (typeof rawMessage === "string" && rawMessage.trim().length > 0) {
          errorMap.set(row.shelter_id, rawMessage)
        } else {
          try {
            const raw = row.errors
            const errors = Array.isArray(raw) ? raw : JSON.parse((raw as string) || "[]")
            errorMap.set(row.shelter_id, errors.length > 0 ? errors[0] : null)
          } catch {
            errorMap.set(row.shelter_id, null)
          }
        }

        startedAtMap.set(row.shelter_id, toIsoTimestamp(row.started_at))
        finishedAtMap.set(row.shelter_id, toIsoTimestamp(row.finished_at))
      }

      const sheltersWithErrors = shelterData.map(s => ({
        ...s,
        active: s.active,
        lastError: errorMap.get(s.id) || null,
        syncStartedAt: startedAtMap.get(s.id) || null,
        syncFinishedAt: finishedAtMap.get(s.id) || null
      }))

      const stats = {
        pending: 0,
        available: 0,
        removed: 0,
        total: 0
      }

      for (const row of dogStats) {
        if (row.status === "pending") stats.pending = row.count
        else if (row.status === "available") stats.available = row.count
        else if (row.status === "removed") stats.removed = row.count
        stats.total += row.count
      }

      return yield* json({
        dogs: stats,
        shelters: sheltersWithErrors
      })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/admin/dogs" }),
    handler: Effect.fn("api.adminListDogs")(function* (req, env) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const url = new URL(req.url)
      const db = drizzle(env.DB)
      
      const status = url.searchParams.get("status")
      if (!status) return yield* json({ error: "Status is required" }, 400)
      
      const shelterId = url.searchParams.get("shelterId") ?? url.searchParams.get("shelter")
      const search = url.searchParams.get("search")
      const sortByParam = url.searchParams.get("sortBy") ?? "createdAt"
      const sortOrderParam = url.searchParams.get("sortOrder") ?? "desc"
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50") || 50, 200)
      const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0") || 0, 0)

      const validStatuses = new Set(["all", "pending", "available", "adopted", "reserved", "removed"])
      if (!validStatuses.has(status)) return yield* json({ error: "Invalid status" }, 400)

      const sortColumns = {
        createdAt: dogs.createdAt,
        updatedAt: dogs.updatedAt,
        lastSeenAt: dogs.lastSeenAt,
        name: dogs.name,
      } as const
      const sortColumn = sortColumns[sortByParam as keyof typeof sortColumns]
      if (!sortColumn) return yield* json({ error: "Invalid sortBy" }, 400)

      const sortOrder = sortOrderParam === "asc" || sortOrderParam === "desc" ? sortOrderParam : "desc"
      const orderBy = sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn)

      const filters: SQL[] = []
      if (status !== "all") filters.push(eq(dogs.status, status as any))
      if (shelterId) filters.push(eq(dogs.shelterId, shelterId))
      if (search) filters.push(like(dogs.name, `%${search}%`))

      const results = yield* Effect.tryPromise({
        try: () => db.select().from(dogs)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(orderBy)
          .limit(limit)
          .offset(offset)
          .all(),
        catch: (e) => new DatabaseError({ operation: "adminListDogs", cause: e })
      })

      const total = yield* Effect.tryPromise({
        try: () => db.select({ count: sql<number>`count(*)` }).from(dogs).where(filters.length > 0 ? and(...filters) : undefined).get(),
        catch: (e) => new DatabaseError({ operation: "adminListDogsCount", cause: e })
      })

      // Get shelter names
      const shelterIds = [...new Set(results.map(d => d.shelterId))]
      const shelterMap = new Map<string, string>()
      if (shelterIds.length > 0) {
        const shelterData = yield* Effect.tryPromise({
          try: () => db.select().from(shelters).where(inArray(shelters.id, shelterIds)).all(),
          catch: (e) => new DatabaseError({ operation: "getShelters", cause: e })
        })
        for (const s of shelterData) shelterMap.set(s.id, s.name)
      }

      // Transform to expected shape
      const transformedDogs = results.map(dog => ({
        id: dog.id,
        name: dog.name,
        shelterId: dog.shelterId,
        shelterName: shelterMap.get(dog.shelterId) ?? "Unknown",
        breed: (dog.breedEstimates as any)?.[0]?.breed ?? null,
        size: (dog.sizeEstimate as any)?.value ?? null,
        age: (dog.ageEstimate as any)?.months?.toString() ?? null,
        sex: dog.sex,
        thumbnailUrl: ((dog.photos as string[] | null) ?? [])[0] ?? null,
        status: dog.status,
        createdAt: dog.createdAt,
        lastSeenAt: dog.lastSeenAt
      }))

      return yield* json({ dogs: transformedDogs, total: total?.count ?? 0 })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/admin/dogs/:id" }),
    handler: Effect.fn("api.getAdminDog")(function* (req, env, params) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const db = drizzle(env.DB)
      const dog = yield* Effect.tryPromise({
        try: () => db.select().from(dogs).where(eq(dogs.id, params.id)).get(),
        catch: (e) => new DatabaseError({ operation: "getAdminDog", cause: e })
      })
      
      if (!dog) return yield* json({ error: "Dog not found" }, 404)
      
      // Get shelter name
      const shelter = yield* Effect.tryPromise({
        try: () => db.select({ name: shelters.name }).from(shelters).where(eq(shelters.id, dog.shelterId)).get(),
        catch: (e) => new DatabaseError({ operation: "getShelter", cause: e })
      })

     // Transform to expected shape
     const photos = (dog.photos as string[] | null) ?? []
      const photosGenerated = (dog.photosGenerated as string[] | null) ?? []

      const professionalPhotos: string[] = []
      const nosePhotos: string[] = []
      for (const url of photosGenerated) {
        if (url.endsWith("-nose") || url.includes("-nose.")) {
          nosePhotos.push(url)
        } else if (url.endsWith("-professional") || url.includes("-professional.")) {
          professionalPhotos.push(url)
        } else {
          professionalPhotos.push(url)
        }
      }

      return yield* json({
        id: dog.id,
        name: dog.name,
        shelterId: dog.shelterId,
        shelterName: shelter?.name ?? "Unknown",
        sourceUrl: dog.sourceUrl,
        status: dog.status,
        breed: (dog.breedEstimates as any)?.[0]?.breed ?? null,
        size: (dog.sizeEstimate as any)?.value ?? null,
        age: (dog.ageEstimate as any)?.months?.toString() ?? null,
        sex: dog.sex,
        description: dog.rawDescription,
        personalityTags: dog.personalityTags,
        healthStatus: null,
        photos: {
          original: photos,
          professional: professionalPhotos,
          nose: nosePhotos
        },
        createdAt: dog.createdAt,
        lastSeenAt: dog.lastSeenAt,
        fingerprint: dog.fingerprint
      })
    }),
  },
  {
    method: "POST",
    pattern: new URLPattern({ pathname: "/admin/dogs/:id/status" }),
    handler: Effect.fn("api.adminSetDogStatus")(function* (req, env, params) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const body = yield* Effect.tryPromise({
        try: () => req.json() as Promise<{ status: "pending" | "available" | "removed" }>,
        catch: (e) => new DatabaseError({ operation: "parseBody", cause: e })
      })

      // Validate status enum
      const validStatuses = ["pending", "available", "removed"]
      if (!validStatuses.includes(body.status)) {
        return yield* json({ error: "Invalid status. Must be: pending, available, or removed" }, 400)
      }

      const db = drizzle(env.DB)
      const result = yield* Effect.tryPromise({
        try: () => db.update(dogs).set({ status: body.status, updatedAt: new Date() }).where(eq(dogs.id, params.id)).returning().get(),
        catch: (e) => new DatabaseError({ operation: "updateDogStatus", cause: e })
      })

      if (!result) return yield* json({ error: "Dog not found" }, 404)

      // Trigger reindex: upsert for available, delete for pending/removed
      if (env.REINDEX_QUEUE) {
        yield* Effect.tryPromise({
          try: () => env.REINDEX_QUEUE!.send({
            type: body.status === "available" ? "upsert" : "delete",
            dogId: result.id,
            description: buildSearchText(result),
            metadata: {
              shelterId: result.shelterId,
              city: result.locationCity || undefined,
              size: (result.sizeEstimate as any)?.value || undefined,
              ageMonths: (result.ageEstimate as any)?.months || undefined,
              sex: result.sex || undefined,
            }
          }),
          catch: (e) => new QueueError({ operation: "enqueue reindex", cause: e })
        })
      }

      return yield* json({ success: true, dog: { id: result.id, status: result.status } })
    }),
  },
  {
    method: "POST",
    pattern: new URLPattern({ pathname: "/admin/dogs/bulk-status" }),
    handler: Effect.fn("api.adminBulkStatus")(function* (req, env) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const body = yield* Effect.tryPromise({
        try: () => req.json() as Promise<{ dogIds: string[], status: "available" | "removed" }>,
        catch: (e) => new DatabaseError({ operation: "parseBody", cause: e })
      })

      const db = drizzle(env.DB)

      // Bulk update in single query
      const results = yield* Effect.tryPromise({
        try: () => db.update(dogs)
          .set({ status: body.status, updatedAt: new Date() })
          .where(inArray(dogs.id, body.dogIds))
          .returning()
          .all(),
        catch: (e) => new DatabaseError({ operation: "bulkUpdate", cause: e })
      })

      // Batch reindex jobs
      if (env.REINDEX_QUEUE && results.length > 0) {
        const jobs = results.map(dog => ({
          body: {
            type: body.status === "available" ? "upsert" as const : "delete" as const,
            dogId: dog.id,
            description: buildSearchText(dog),
            metadata: {
              shelterId: dog.shelterId,
              city: dog.locationCity || undefined,
              size: (dog.sizeEstimate as any)?.value || undefined,
              ageMonths: (dog.ageEstimate as any)?.months || undefined,
              sex: dog.sex || undefined,
            }
          }
        }))

        yield* Effect.tryPromise({
          try: () => env.REINDEX_QUEUE!.sendBatch(jobs),
          catch: () => new QueueError({ operation: "bulkReindex", cause: null })
        }
        )
      }

      return yield* json({ success: true, updated: results.length, failed: body.dogIds.length - results.length })
    }),
  },
  {
    method: "PUT",
    pattern: new URLPattern({ pathname: "/admin/dogs/:id" }),
    handler: Effect.fn("api.adminUpdateDog")(function* (req, env, params) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const body = yield* Effect.tryPromise({
        try: () => req.json() as Promise<any>,
        catch: (e) => new DatabaseError({ operation: "parseBody", cause: e })
      })

      // Only allow updating specific safe fields
      const allowedFields = ["name", "sex", "rawDescription", "personalityTags", "generatedBio"] as const
      const safeUpdate: Record<string, any> = { updatedAt: new Date() }
      for (const key of allowedFields) {
        if (body[key] !== undefined) {
          safeUpdate[key] = body[key]
        }
      }
      // Handle AI estimate fields specially
      if (body.breed) safeUpdate.breedEstimates = [{ breed: body.breed, confidence: 1.0 }]
      if (body.size) safeUpdate.sizeEstimate = { value: body.size, confidence: 1.0 }
      if (body.age) safeUpdate.ageEstimate = { months: parseInt(body.age) || 12, confidence: 1.0 }

      const db = drizzle(env.DB)
      const result = yield* Effect.tryPromise({
        try: () => db.update(dogs).set(safeUpdate).where(eq(dogs.id, params.id)).returning().get(),
        catch: (e) => new DatabaseError({ operation: "updateDog", cause: e })
      })

      if (!result) return yield* json({ error: "Dog not found" }, 404)
      
      // Trigger reindex if available
      if (env.REINDEX_QUEUE && result.status === "available") {
        yield* Effect.tryPromise({
          try: () => env.REINDEX_QUEUE!.send({
            type: "upsert",
            dogId: result.id,
            description: buildSearchText(result),
            metadata: {
              shelterId: result.shelterId,
              city: result.locationCity || undefined,
              size: (result.sizeEstimate as any)?.value || undefined,
              ageMonths: (result.ageEstimate as any)?.months || undefined,
              sex: result.sex || undefined,
            }
          }),
          catch: () => new QueueError({ operation: "reindex", cause: null })
        })
      }

      return yield* json({ success: true, dog: result })
    }),
  },
  {
    method: "DELETE",
    pattern: new URLPattern({ pathname: "/admin/dogs/:id" }),
    handler: Effect.fn("api.adminDeleteDog")(function* (req, env, params, ctx: ExecutionContext) {
      if (!isAuthorized(req, env)) {
        return yield* json({ error: "Unauthorized" }, 401)
      }
      const db = drizzle(env.DB)

      const dog = yield* Effect.tryPromise({
        try: () => db.select({ id: dogs.id, fingerprint: dogs.fingerprint }).from(dogs).where(eq(dogs.id, params.id)).get(),
        catch: (e) => new DatabaseError({ operation: "getDogForDelete", cause: e })
      })

      if (!dog) {
        return yield* json({ error: "Dog not found" }, 404)
      }

      const fingerprint = dog.fingerprint
      const dogId = dog.id

      // Delete from D1 first (authoritative data)
      yield* Effect.tryPromise({
        try: () => db.delete(dogs).where(eq(dogs.id, params.id)).run(),
        catch: (e) => new DatabaseError({ operation: "deleteDog", cause: e })
      })

      // Enqueue reindex job before returning
      if (env.REINDEX_QUEUE) {
        yield* Effect.tryPromise({
          try: () => env.REINDEX_QUEUE!.send({ type: "delete", dogId: params.id }),
          catch: () => new QueueError({ operation: "reindex", cause: null })
        })
      }

      // Return success immediately, do R2 cleanup in background
      const cleanup = Effect.gen(function* () {
        // Cleanup original photos
        yield* Effect.tryPromise({
          try: async () => {
            let cursor: string | undefined
            do {
              const list = await env.PHOTOS_ORIGINAL.list({
                prefix: `dogs/${dogId}/`,
                ...(cursor ? { cursor } : {})
              })
              const keys = list.objects.map(o => o.key)
              if (keys.length > 0) {
                await env.PHOTOS_ORIGINAL.delete(keys)
              }
              cursor = list.truncated ? list.cursor : undefined
            } while (cursor)
          },
          catch: (e) => new R2Error({ operation: "deleteOriginalPhotos", cause: e })
        }).pipe(
          Effect.catchAll(e => Effect.sync(() => console.error("Failed to delete original photos", e)))
        )

        // Cleanup generated photos (only if fingerprint is valid)
        if (fingerprint && fingerprint.length >= 8) {
          yield* Effect.tryPromise({
            try: async () => {
              let cursor: string | undefined
              do {
                const list = await env.PHOTOS_GENERATED.list({
                  prefix: `${fingerprint}-`,
                  ...(cursor ? { cursor } : {})
                })
                const keys = list.objects.map(o => o.key)
                if (keys.length > 0) {
                  await env.PHOTOS_GENERATED.delete(keys)
                }
                cursor = list.truncated ? list.cursor : undefined
              } while (cursor)
            },
            catch: (e) => new R2Error({ operation: "deleteGeneratedPhotos", cause: e })
          }).pipe(
            Effect.catchAll(e => Effect.sync(() => console.error("Failed to delete generated photos", e)))
          )
        }
      }).pipe(
        Effect.catchAll(e => Effect.sync(() => console.error("Background cleanup failed", e)))
      )

      ctx.waitUntil(Effect.runPromise(cleanup))

      return yield* json({ success: true })
    }),
  },
 {
   method: "POST",
   pattern: new URLPattern({ pathname: "/admin/dogs/:id/regenerate" }),
   handler: Effect.fn("api.adminRegenerateDog")(function* (req, env, params) {
     if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
     const body = yield* Effect.tryPromise({
        try: () => req.json() as Promise<{ target: "bio" | "photos" | "all" }>,
        catch: (e) => new DatabaseError({ operation: "parseBody", cause: e })
      })

      const db = drizzle(env.DB)
      const dog = yield* Effect.tryPromise({
        try: () => db.select().from(dogs).where(eq(dogs.id, params.id)).get(),
        catch: (e) => new DatabaseError({ operation: "getDog", cause: e })
      })

      if (!dog) return yield* json({ error: "Dog not found" }, 404)

      const regeneratePhotos = body.target === "photos" || body.target === "all"
      if (regeneratePhotos) {
        const photoGenQueue = env.PHOTO_GEN_QUEUE
        if (!photoGenQueue) {
          return yield* json({ error: "PHOTO_GEN_QUEUE not configured" }, 500)
        }

        const rootTraceId = crypto.randomUUID()
        const imageQueue = env.IMAGE_QUEUE
        const externalUrls = (dog.photos || []).filter((p: string) => p.startsWith("http"))

        yield* Effect.tryPromise({
          try: () =>
            db
              .update(dogs)
              .set({ photosGenerated: [], updatedAt: new Date() })
              .where(eq(dogs.id, dog.id)),
          catch: (e) => new DatabaseError({ operation: "clear photosGenerated", cause: e }),
        })

        if (imageQueue && externalUrls.length > 0) {
          const imageJob = makeEnvelope({
            type: "images.processOriginal",
            payload: { dogId: dog.id, urls: externalUrls },
            source: "admin",
            parentTraceId: rootTraceId,
          })

          yield* Effect.tryPromise({
            try: () => imageQueue.send(imageJob),
            catch: (e) => new QueueError({ operation: "enqueue image job", cause: e }),
          })
        }

        const professionalJob = makeEnvelope({
          type: "photos.generate",
          payload: { dogId: dog.id, variant: "professional" as const },
          source: "admin",
          parentTraceId: rootTraceId,
        })

        const noseJob = makeEnvelope({
          type: "photos.generate",
          payload: { dogId: dog.id, variant: "nose" as const },
          source: "admin",
          parentTraceId: rootTraceId,
        })

        yield* Effect.tryPromise({
          try: () => photoGenQueue.send(professionalJob),
          catch: (e) => new QueueError({ operation: "enqueue photo job: professional", cause: e }),
        })

        yield* Effect.tryPromise({
          try: () => photoGenQueue.send(noseJob),
          catch: (e) => new QueueError({ operation: "enqueue photo job: nose", cause: e }),
        })

        return yield* json({
          success: true,
          traceId: rootTraceId,
          expected: [
            `generated/${dog.fingerprint}-professional`,
            `generated/${dog.fingerprint}-nose`,
          ],
        })
      }

      return yield* json({
        success: true,
        message: "Bio regeneration is not implemented yet",
      })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/admin/shelters" }),
    handler: Effect.fn("api.adminListShelters")(function* (req, env) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const db = drizzle(env.DB)
      const results = yield* Effect.tryPromise({
        try: () => db.select({
          id: shelters.id,
          slug: shelters.slug,
          name: shelters.name,
          url: shelters.url,
          city: shelters.city,
          region: shelters.region,
          phone: shelters.phone,
          email: shelters.email,
          lat: shelters.lat,
          lng: shelters.lng,
          active: shelters.active,
          status: shelters.status,
          lastSync: shelters.lastSync,
          dogCount: sql<number>`count(${dogs.id})`,
        })
          .from(shelters)
          .leftJoin(dogs, eq(shelters.id, dogs.shelterId))
          .groupBy(shelters.id)
          .orderBy(shelters.name)
          .all(),
        catch: (e) => new DatabaseError({ operation: "adminListShelters", cause: e })
      })

      return yield* json({
        shelters: results.map(s => ({
          ...s,
          active: s.active,
        }))
      })
    }),
  },
  {
    method: "POST",
    pattern: new URLPattern({ pathname: "/admin/shelters/:id/scrape" }),
    handler: Effect.fn("api.adminScrapeShelter")(function* (req, env, params) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const db = drizzle(env.DB)
      const shelter = yield* Effect.tryPromise({
        try: () => db.select().from(shelters).where(eq(shelters.id, params.id)).get(),
        catch: (e) => new DatabaseError({ operation: "getShelter", cause: e })
      })

      if (!shelter) return yield* json({ error: "Shelter not found" }, 404)

      if (!env.SCRAPE_QUEUE) return yield* json({ error: "SCRAPE_QUEUE not configured" }, 500)

      const syncLogId = crypto.randomUUID()
      const startedAt = new Date()

      yield* Effect.tryPromise({
        try: () =>
          db.insert(syncLogs).values({
            id: syncLogId,
            shelterId: shelter.id,
            startedAt,
            dogsAdded: 0,
            dogsUpdated: 0,
            dogsRemoved: 0,
            errors: [],
          }),
        catch: (e) => new DatabaseError({ operation: "create sync log", cause: e }),
      })

      yield* Effect.tryPromise({
        try: () => env.SCRAPE_QUEUE!.send({
          shelterId: shelter.id,
          shelterSlug: shelter.slug,
          baseUrl: shelter.url,
          syncLogId
        }),
        catch: (e) => new QueueError({ operation: "enqueue scrape", cause: e })
      })

      return yield* json({ success: true, message: `Scrape queued for ${shelter.name}` })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/admin/shelters/:id" }),
    handler: Effect.fn("api.adminGetShelter")(function* (req, env, params) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const db = drizzle(env.DB)
      const shelter = yield* Effect.tryPromise({
        try: () => db.select().from(shelters).where(eq(shelters.id, params.id)).get(),
        catch: (e) => new DatabaseError({ operation: "getShelter", cause: e })
      })

      if (!shelter) return yield* json({ error: "Shelter not found" }, 404)

      const dogCount = yield* Effect.tryPromise({
        try: () => db.select({ count: sql<number>`count(*)` }).from(dogs).where(eq(dogs.shelterId, params.id)).get(),
        catch: (e) => new DatabaseError({ operation: "getShelterDogCount", cause: e })
      })

      const logs = yield* Effect.tryPromise({
        try: () => db.select().from(syncLogs)
          .where(eq(syncLogs.shelterId, params.id))
          .orderBy(desc(syncLogs.startedAt))
          .limit(50)
          .all(),
        catch: (e) => new DatabaseError({ operation: "getShelterSyncLogs", cause: e })
      })

      return yield* json({
        shelter: {
          ...shelter,
          active: shelter.active,
          dogCount: dogCount?.count ?? 0,
        },
        syncLogs: logs,
      })
    }),
  },
  {
    method: "PUT",
    pattern: new URLPattern({ pathname: "/admin/shelters/:id" }),
    handler: Effect.fn("api.adminUpdateShelter")(function* (req, env, params) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const body = yield* Effect.tryPromise({
        try: () => req.json() as Promise<{
          name?: string
          url?: string
          city?: string
          region?: string | null
          phone?: string | null
          email?: string | null
          lat?: number | null
          lng?: number | null
          active?: boolean
        }>,
        catch: (e) => new DatabaseError({ operation: "parseBody", cause: e })
      })

      const db = drizzle(env.DB)
      const update: Record<string, unknown> = {}
      if (typeof body.active === "boolean") {
        update.active = body.active
        update.status = body.active ? "active" : "inactive"
      }
      if (typeof body.name === "string") {
        const value = body.name.trim()
        if (!value) return yield* json({ error: "Name cannot be empty" }, 400)
        update.name = value
      }
      if (typeof body.url === "string") {
        const value = body.url.trim()
        if (!value) return yield* json({ error: "URL cannot be empty" }, 400)
        update.url = value
      }
      if (typeof body.city === "string") {
        const value = body.city.trim()
        if (!value) return yield* json({ error: "City cannot be empty" }, 400)
        update.city = value
      }
      if (body.region === null) {
        update.region = null
      } else if (typeof body.region === "string") {
        const value = body.region.trim()
        update.region = value ? value : null
      }
      if (body.phone === null) {
        update.phone = null
      } else if (typeof body.phone === "string") {
        const value = body.phone.trim()
        update.phone = value ? value : null
      }
      if (body.email === null) {
        update.email = null
      } else if (typeof body.email === "string") {
        const value = body.email.trim()
        update.email = value ? value : null
      }
      if (body.lat === null) {
        update.lat = null
      } else if (typeof body.lat === "number" && Number.isFinite(body.lat)) {
        update.lat = body.lat
      }
      if (body.lng === null) {
        update.lng = null
      } else if (typeof body.lng === "number" && Number.isFinite(body.lng)) {
        update.lng = body.lng
      }

      if (Object.keys(update).length === 0) {
        return yield* json({ error: "No fields to update" }, 400)
      }

      const result = yield* Effect.tryPromise({
        try: () => db.update(shelters).set(update).where(eq(shelters.id, params.id)).returning().get(),
        catch: (e) => new DatabaseError({ operation: "updateShelter", cause: e })
      })

      if (!result) return yield* json({ error: "Shelter not found" }, 404)

      return yield* json({ success: true, shelter: result })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/shelters" }),
    handler: Effect.fn("api.listShelters")(function* (_req, env) {
      const db = drizzle(env.DB)
      const results = yield* Effect.tryPromise({
        try: () => db.select().from(shelters).all(),
        catch: (e) => new DatabaseError({ operation: "listShelters", cause: e })
      })
      return yield* json({ shelters: results })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/photos/generated/:key" }),
    handler: Effect.fn("api.getGeneratedPhoto")(function* (_req, env, params) {
      const key = decodeURIComponent(params.key)
      const object = yield* Effect.tryPromise({
        try: () => env.PHOTOS_GENERATED.get(key),
        catch: (e) => new R2Error({ operation: "getGeneratedPhoto", cause: e })
      })
      
      if (!object) {
        return yield* json({ error: "Photo not found" }, 404)
      }
      
      const headers = new Headers()
      const contentType = object.httpMetadata?.contentType || (key.endsWith(".webp") ? "image/webp" : "image/png")
      headers.set("Content-Type", contentType)
      headers.set("Cache-Control", "public, max-age=31536000")
      headers.set("Access-Control-Allow-Origin", "*")
      
      return new Response(object.body, { headers })
    }),
  },
  {
    method: "POST",
   pattern: new URLPattern({ pathname: "/admin/sync-generated-photos" }),
   handler: Effect.fn("api.adminSyncGeneratedPhotos")(function* (req, env) {
     if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }

     const publicDomain = "dogpile-generated.extropy.club"
     
     const listed = yield* Effect.tryPromise({
        try: () => env.PHOTOS_GENERATED.list(),
        catch: (e) => new R2Error({ operation: "listGeneratedPhotos", cause: e })
      })
      
      const updates: { fingerprint: string; url: string }[] = []
      
      for (const obj of listed.objects) {
        const match = obj.key.match(/^(.+)-nose\.png$/)
        if (match) {
          const fingerprint = match[1]
          const url = `https://${publicDomain}/${obj.key}`
          updates.push({ fingerprint, url })
        }
      }
      
      let updated = 0
      for (const { fingerprint, url } of updates) {
        const result = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(
              `UPDATE dogs SET photos_generated = ? WHERE fingerprint = ?`
            ).bind(JSON.stringify([url]), fingerprint).run(),
          catch: (e) => new DatabaseError({ operation: "syncPhotosUpdate", cause: e })
        })
        if (result.meta.changes > 0) updated++
      }
      
      return yield* json({ 
        message: "Sync complete", 
        found: updates.length, 
        updated,
        sample: updates.slice(0, 3)
      })
    }),
  },
  {
   method: "POST",
   pattern: new URLPattern({ pathname: "/admin/backfill-images" }),
   handler: Effect.fn("api.adminBackfillImages")(function* (req, env) {
     const auth = req.headers.get("Authorization")
     if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) {
       return yield* json({ error: "Unauthorized" }, 401)
     }

     if (!env.IMAGE_QUEUE) {
       return yield* json({ error: "IMAGE_QUEUE not configured" }, 500)
     }

     const db = drizzle(env.DB)
     
     const allDogs = yield* Effect.tryPromise({
       try: () =>
         db.select({ id: dogs.id, photos: dogs.photos })
           .from(dogs)
           .where(eq(dogs.status, "available"))
           .all(),
       catch: (e) => new DatabaseError({ operation: "backfillListDogs", cause: e })
     })

     const jobs: { body: { dogId: string; urls: string[] } }[] = []

     for (const dog of allDogs) {
       const externalUrls = (dog.photos || []).filter((p: string) => p.startsWith("http"))
       if (externalUrls.length > 0) {
         jobs.push({ body: { dogId: dog.id, urls: externalUrls } })
       }
     }

     if (jobs.length > 0) {
       const batchSize = 100
       for (let i = 0; i < jobs.length; i += batchSize) {
         const chunk = jobs.slice(i, i + batchSize)
         yield* Effect.tryPromise({
           try: () => env.IMAGE_QUEUE!.sendBatch(chunk),
           catch: (e) => new QueueError({ operation: "sendBatch", cause: e })
         })
       }
     }

     return yield* json({
       status: "ok",
       scanned: allDogs.length,
       enqueued: jobs.length
     })
   }),
 },
  {
    method: "POST",
    pattern: new URLPattern({ pathname: "/admin/reindex" }),
    handler: Effect.fn("api.reindex")(function* (req, env) {
      const authHeader = req.headers.get("Authorization")
      if (authHeader !== `Bearer ${env.ADMIN_KEY}`) {
        return yield* json({ error: "Unauthorized" }, 401)
      }

      if (!env.REINDEX_QUEUE) {
        return yield* json({ error: "REINDEX_QUEUE not configured" }, 500)
      }

      const url = new URL(req.url)
      const parsedLimit = parseInt(url.searchParams.get("limit") || "10000")
      const limit = Math.min(isNaN(parsedLimit) ? 10000 : parsedLimit, 10000)

      const db = drizzle(env.DB)
      const allDogs = yield* Effect.tryPromise({
        try: () => db.select().from(dogs).where(eq(dogs.status, "available")).limit(limit).all(),
        catch: (e) => new DatabaseError({ operation: "fetch all dogs", cause: e })
      })

      // Queue reindex jobs in batches
      const jobs: { body: ReindexJob }[] = allDogs.map(dog => {
        return {
          body: {
            type: "upsert" as const,
            dogId: dog.id,
            description: buildSearchText(dog),
            metadata: {
              shelterId: dog.shelterId,
              city: dog.locationCity || undefined,
              size: (dog.sizeEstimate as any)?.value || undefined,
              ageMonths: (dog.ageEstimate as any)?.months || undefined,
              sex: dog.sex || undefined,
            }
          }
        }
      })

      const BATCH_SIZE = 100
      for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const chunk = jobs.slice(i, i + BATCH_SIZE)
        yield* Effect.tryPromise({
          try: () => env.REINDEX_QUEUE!.sendBatch(chunk),
          catch: (e) => new QueueError({ operation: "sendBatch reindex", cause: e })
        })
      }

      return yield* json({ queued: jobs.length })
    }),
  },
	  {
	    method: "GET",
	    pattern: new URLPattern({ pathname: "/admin/sync-stats" }),
	    handler: Effect.fn("api.syncStats")(function* (req, env) {
      const authHeader = req.headers.get("Authorization")
      if (authHeader !== `Bearer ${env.ADMIN_KEY}`) {
        return yield* json({ error: "Unauthorized" }, 401)
      }

	      const db = drizzle(env.DB)
	      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
	      const startedAtMs = sql<number>`CASE WHEN ${syncLogs.startedAt} < 1000000000000 THEN ${syncLogs.startedAt} * 1000 ELSE ${syncLogs.startedAt} END`

	      const logs = yield* Effect.tryPromise({
	        try: () =>
	          db.select().from(syncLogs)
	            .where(sql`${startedAtMs} > ${since.getTime()}`)
	            .orderBy(desc(startedAtMs))
	            .all(),
	        catch: (e) => new DatabaseError({ operation: "get sync stats", cause: e })
	      })

      const total = logs.length
      const successful = logs.filter(l => l.errors.length === 0).length
      const avgAdded = logs.reduce((sum, l) => sum + l.dogsAdded, 0) / (total || 1)
      const avgUpdated = logs.reduce((sum, l) => sum + l.dogsUpdated, 0) / (total || 1)
      const avgRemoved = logs.reduce((sum, l) => sum + l.dogsRemoved, 0) / (total || 1)
      const recentErrors = logs.flatMap(l => l.errors).slice(0, 10)

      return yield* json({
        period: "24h",
        totalSyncs: total,
        successRate: total ? (successful / total) : 1,
        averages: { added: avgAdded, updated: avgUpdated, removed: avgRemoved },
        recentErrors,
      })
    }),
  },
  {
    method: "GET",
    pattern: new URLPattern({ pathname: "/admin/costs" }),
    handler: Effect.fn("api.adminCosts")(function* (req, env) {
      if (!isAuthorized(req, env)) { return yield* json({ error: "Unauthorized" }, 401) }
      const url = new URL(req.url)
      const db = drizzle(env.DB)
      
      const fromStr = url.searchParams.get("from")
      const toStr = url.searchParams.get("to")
      const groupByParam = url.searchParams.get("groupBy")
      
      const from = fromStr 
        ? new Date(fromStr) 
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const to = toStr 
        ? new Date(toStr) 
        : new Date()

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return yield* json({ error: "Invalid from/to" }, 400)
      }

	      const groupBy = groupByParam === "day" || groupByParam === "model" || groupByParam === "operation"
	        ? groupByParam
	        : "day"

	      const createdAtMs = sql<number>`CASE WHEN ${apiCosts.createdAt} < 1000000000000 THEN ${apiCosts.createdAt} * 1000 ELSE ${apiCosts.createdAt} END`
	      const rangeFilter = and(
	        sql`${createdAtMs} >= ${from.getTime()}`,
	        sql`${createdAtMs} <= ${to.getTime()}`
	      )

      const totalData = yield* Effect.tryPromise({
        try: () => db.select({
          costUsd: sql<number>`SUM(${apiCosts.costUsd})`,
          calls: sql<number>`COUNT(*)`,
          tokens: sql<number>`SUM(${apiCosts.inputTokens} + ${apiCosts.outputTokens})`
        })
        .from(apiCosts)
        .where(rangeFilter)
        .get(),
        catch: (e) => new DatabaseError({ operation: "adminCostsTotal", cause: e })
      })

      const totals = {
        costUsd: sql<number>`SUM(${apiCosts.costUsd})`,
        calls: sql<number>`COUNT(*)`,
        tokens: sql<number>`SUM(${apiCosts.inputTokens} + ${apiCosts.outputTokens})`,
      } as const

	      const breakdown: CostsResponse["breakdown"] =
	        groupBy === "day"
	          ? yield* Effect.tryPromise({
	              try: () => {
	                const dateExpr = sql<string>`strftime('%Y-%m-%d', ${createdAtMs} / 1000, 'unixepoch')`
	                return db
	                  .select({ date: dateExpr, ...totals })
	                  .from(apiCosts)
	                  .where(rangeFilter)
                  .groupBy(dateExpr)
                  .orderBy(dateExpr)
                  .all()
              },
              catch: (e) => new DatabaseError({ operation: "adminCostsBreakdown(day)", cause: e })
            })
          : groupBy === "model"
          ? yield* Effect.tryPromise({
              try: () =>
                db
                  .select({ model: apiCosts.model, ...totals })
                  .from(apiCosts)
                  .where(rangeFilter)
                  .groupBy(apiCosts.model)
                  .orderBy(desc(sql`SUM(${apiCosts.costUsd})`))
                  .all(),
              catch: (e) => new DatabaseError({ operation: "adminCostsBreakdown(model)", cause: e })
            })
          : yield* Effect.tryPromise({
              try: () =>
                db
                  .select({ operation: apiCosts.operation, ...totals })
                  .from(apiCosts)
                  .where(rangeFilter)
                  .groupBy(apiCosts.operation)
                  .orderBy(desc(sql`SUM(${apiCosts.costUsd})`))
                  .all(),
              catch: (e) => new DatabaseError({ operation: "adminCostsBreakdown(operation)", cause: e })
            })

      const response: CostsResponse = {
        groupBy,
        total: {
          costUsd: totalData?.costUsd ?? 0,
          calls: totalData?.calls ?? 0,
          tokens: totalData?.tokens ?? 0,
        },
        breakdown: breakdown ?? []
      }

      return yield* json(response)
    }),
  },
]

const notFound = () => json({ error: "Not Found" }, 404)

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = request.url
    const method = request.method.toUpperCase()

    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url)
      if (match) {
        const params = match.pathname.groups as Record<string, string>
        const program = route.handler(request, env, params, _ctx).pipe(
          Effect.catchAll((error) => {
            console.error(`API Error [${error._tag}]:`, error)
            return json({
              error: error._tag,
              message: "An internal error occurred",
              operation: (error as any).operation
            }, 500)
          })
        )
        return Effect.runPromise(program)
      }
    }

    return Effect.runPromise(notFound() as any)
  },
}

interface CostsResponse {
  groupBy: "day" | "operation" | "model"
  total: {
    costUsd: number
    calls: number
    tokens: number
  }
  breakdown: Array<
    | { date: string; costUsd: number; calls: number; tokens: number }
    | { operation: string; costUsd: number; calls: number; tokens: number }
    | { model: string; costUsd: number; calls: number; tokens: number }
  >
}
