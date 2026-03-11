import { Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { UnrecoverableError } from "../errors.js"

const apiUrlOpt = Options.text("api-url").pipe(Options.withDefault("http://localhost:8787"))
const adminKeyOpt = Options.text("admin-key").pipe(Options.optional)
const dryRunOpt = Options.boolean("dry-run").pipe(Options.optional)

interface Dog {
  id: string
  name: string
  shelterId: string
  status: string
}

const approveAllCommand = Command.make("approve-all", {
  apiUrl: apiUrlOpt,
  adminKey: adminKeyOpt,
  dryRun: dryRunOpt,
}, ({ apiUrl, adminKey, dryRun }) =>
  Effect.gen(function* () {
    const key = Option.getOrElse(adminKey, () =>
      process.env.ADMIN_KEY ?? process.env.PUBLIC_ADMIN_KEY ?? "dev-admin-key-123"
    )

    const isDryRun = Option.getOrElse(dryRun, () => false)

    yield* Console.log("Fetching pending dogs...")

    // Fetch pending dogs
    const pendingDogs = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${apiUrl}/admin/dogs?status=pending`, {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (!res.ok) {
          const body = await res.text().catch(() => "")
          throw new Error(`API error: ${res.status} ${res.statusText} ${body}`.trim())
        }
        return res.json() as Promise<{ dogs: Dog[] }>
      },
      catch: (e) => new UnrecoverableError({ reason: String(e) }),
    })

    if (pendingDogs.dogs.length === 0) {
      yield* Console.log("No pending dogs found.")
      return
    }

    yield* Console.log(`Found ${pendingDogs.dogs.length} pending dogs`)

    if (isDryRun) {
      yield* Console.log("\n[DRY RUN] The following dogs would be approved:")
      for (const dog of pendingDogs.dogs) {
        yield* Console.log(`  - ${dog.name} (${dog.id}) [${dog.shelterId}]`)
      }
      yield* Console.log("\nRun without --dry-run to actually approve these dogs.")
      return
    }

    // Extract dog IDs
    const dogIds = pendingDogs.dogs.map(d => d.id)

    yield* Console.log(`Approving ${dogIds.length} dogs...`)

    // Call bulk status endpoint
    const result = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${apiUrl}/admin/dogs/bulk-status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ dogIds, status: "available" }),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => "")
          throw new Error(`API error: ${res.status} ${res.statusText} ${body}`.trim())
        }
        return res.json() as Promise<{ updated: number; failed: number }>
      },
      catch: (e) => new UnrecoverableError({ reason: String(e) }),
    })

    yield* Console.log(`✅ Updated: ${result.updated}, Failed: ${result.failed}`)

    if (result.failed > 0) {
      yield* Console.log("\nSome dogs failed to update. Check the API logs for details.")
    }
  })
)

export const dogsCommand = Command.make("dogs", {}).pipe(
  Command.withSubcommands([approveAllCommand])
)
