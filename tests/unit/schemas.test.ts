import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCHEMA_DIR, buildSchemaFiles } from '../../scripts/export-schemas'

describe('published JSON Schemas', () => {
  const built = buildSchemaFiles()

  it('match the contracts (run npm run schemas after a contract change)', () => {
    expect(readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json')).sort()).toEqual(Object.keys(built).sort())
    for (const [fileName, text] of Object.entries(built)) {
      expect(readFileSync(join(SCHEMA_DIR, fileName), 'utf8').replace(/\r\n/g, '\n'), fileName).toBe(text)
    }
  })

  it('the cancelled worker message carries deleteMs', () => {
    const doc = JSON.parse(readFileSync(join(SCHEMA_DIR, 'WorkerResponse.schema.json'), 'utf8')) as {
      oneOf?: { properties: { type: { const: string } } & Record<string, unknown>; required: string[] }[]
      anyOf?: { properties: { type: { const: string } } & Record<string, unknown>; required: string[] }[]
    }
    const variants = doc.oneOf ?? doc.anyOf ?? []
    const cancelled = variants.find((v) => v.properties.type.const === 'cancelled')
    expect(cancelled?.required).toEqual(expect.arrayContaining(['cancelMs', 'deleteMs', 'partialRowsDeleted']))
  })
})
