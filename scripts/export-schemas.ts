/**
 * Writes JSON Schema files for the public data contracts into schemas/.
 * Run with: npm run schemas
 * A unit test compares the files on disk with buildSchemaFiles(), so a contract change
 * without a rerun fails the tests.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  AuditRow,
  NormalizedUsageRow,
  PricingSnapshot,
  Report,
  WorkerRequest,
  WorkerResponse,
} from '../src/engine/contracts'

const SCHEMAS: Record<string, z.ZodType> = {
  NormalizedUsageRow,
  AuditRow,
  PricingSnapshot,
  Report,
  WorkerRequest,
  WorkerResponse,
}

export const SCHEMA_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'schemas')

/** File name to file text for every exported schema. */
export function buildSchemaFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    // File and Blob fields (z.instanceof, z.any) have no JSON Schema form; they become open schemas.
    const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any', target: 'draft-2020-12' })
    const { $schema, ...body } = json as Record<string, unknown>
    const doc = { $schema, $id: `${name}.schema.json`, title: name, ...body }
    out[`${name}.schema.json`] = `${JSON.stringify(doc, null, 2)}\n`
  }
  return out
}

function main(): void {
  mkdirSync(SCHEMA_DIR, { recursive: true })
  for (const [fileName, text] of Object.entries(buildSchemaFiles())) {
    const file = join(SCHEMA_DIR, fileName)
    writeFileSync(file, text)
    console.log(`wrote ${file}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
