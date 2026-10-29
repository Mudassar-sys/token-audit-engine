/**
 * Writes JSON Schema files for the public data contracts into schemas/.
 * Run with: npm run schemas
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'schemas')
mkdirSync(outDir, { recursive: true })

for (const [name, schema] of Object.entries(SCHEMAS)) {
  // File and Blob fields (z.instanceof, z.any) have no JSON Schema form; they become open schemas.
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any', target: 'draft-2020-12' })
  const { $schema, ...body } = json as Record<string, unknown>
  const doc = { $schema, $id: `${name}.schema.json`, title: name, ...body }
  const file = join(outDir, `${name}.schema.json`)
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`wrote ${file}`)
}
