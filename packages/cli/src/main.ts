import { Command } from "@effect/cli"
import { NodeContext } from "@effect/platform-node"
import { Effect, Exit, Cause } from "effect"
import { dbCommand } from "./commands/db.js"
import { scrapeCommand } from "./commands/scrape.js"
import { r2Command } from "./commands/r2.js"
import { photosCommand } from "./commands/photos.js"
import { dogsCommand } from "./commands/dogs.js"

const cli = Command.make("dogpile").pipe(
  Command.withSubcommands([dbCommand, r2Command, scrapeCommand, photosCommand, dogsCommand])
)

const run = Command.run(cli, {
  name: "dogpile",
  version: "0.0.1",
})

const main = async () => {
  const program = Effect.suspend(() => run(process.argv)).pipe(
    Effect.provide(NodeContext.layer)
  )
  const exit = await Effect.runPromiseExit(program)
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err)
  process.exit(1)
})
