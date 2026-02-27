import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/**/*.sql.ts",
  out: "./migrations",
  dbCredentials: {
    url: "./.drizzle-dev/sonata.db",
  },
  strict: true,
  verbose: true,
})
