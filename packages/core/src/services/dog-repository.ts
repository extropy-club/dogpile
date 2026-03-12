import { Context, Effect, Layer } from "effect"
import type { Dog } from "../domain/dog.js"
import { NotFoundError, StorageError } from "../domain/errors.js"

export interface CreateDogInput {
  readonly shelterId: string
  readonly externalId: string
  readonly name: string
  readonly sex?: string | null
  readonly locationName?: string | null
  readonly locationCity?: string | null
  readonly locationLat?: number | null
  readonly locationLng?: number | null
  readonly isFoster?: boolean | null
  readonly breedEstimates?: readonly { breed: string; confidence: number }[]
  readonly sizeEstimate?: { value: string; confidence: number } | null
  readonly ageEstimate?: { months: number; confidence: number; rangeMin: number; rangeMax: number } | null
  readonly weightEstimate?: { kg: number; confidence: number; rangeMin: number; rangeMax: number } | null
  readonly personalityTags?: readonly string[]
  readonly vaccinated?: boolean | null
  readonly sterilized?: boolean | null
  readonly chipped?: boolean | null
  readonly goodWithKids?: boolean | null
  readonly goodWithDogs?: boolean | null
  readonly goodWithCats?: boolean | null
  readonly furLength?: string | null
  readonly furType?: string | null
  readonly colorPrimary?: string | null
  readonly colorSecondary?: string | null
  readonly colorPattern?: string | null
  readonly earType?: string | null
  readonly tailType?: string | null
  readonly photos?: readonly string[]
  readonly photosGenerated?: readonly string[]
  readonly sourceUrl?: string | null
  readonly urgent?: boolean
  readonly fingerprint: string
  readonly rawDescription?: string | null
  readonly generatedBio?: string | null
}

export interface DogFilters {
  readonly shelterId?: string
  readonly city?: string
  readonly size?: string
  readonly sex?: string
  readonly tag?: string
  readonly urgent?: boolean
  readonly status?: string
  readonly limit?: number
  readonly offset?: number
}

export class DogRepository extends Context.Tag("@dogpile/DogRepository")<
  DogRepository,
  {
    readonly findById: (id: string) => Effect.Effect<Dog, NotFoundError | StorageError>
    readonly findByExternalId: (shelterId: string, externalId: string) => Effect.Effect<Dog | null, StorageError>
    readonly findAll: (filters: DogFilters) => Effect.Effect<readonly Dog[], StorageError>
    readonly findByIds: (ids: readonly string[]) => Effect.Effect<readonly Dog[], StorageError>
    readonly create: (dog: CreateDogInput) => Effect.Effect<Dog, StorageError>
    readonly update: (id: string, dog: Partial<CreateDogInput>) => Effect.Effect<Dog, NotFoundError | StorageError>
    readonly delete: (id: string) => Effect.Effect<void, StorageError>
    readonly deleteByShelterId: (shelterId: string) => Effect.Effect<number, StorageError>
    readonly getChecksumsByShelterId: (shelterId: string) => Effect.Effect<ReadonlyMap<string, string>, StorageError>
  }
>() {
  static readonly make = (impl: Context.Tag.Service<DogRepository>) => Layer.succeed(this, impl)
}
