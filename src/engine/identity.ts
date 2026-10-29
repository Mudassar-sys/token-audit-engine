import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { IdentityInputs, type VariantId } from './contracts'
import { adapterForVariant } from './adapters/index'

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in order, no whitespace.
 * Undefined object members are dropped, as JSON.stringify does. BigInt and non-finite numbers are refused.
 */
export function canonicalJson(value: unknown): string {
  return write(value, [])
}

function write(value: unknown, seen: object[]): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`)
      return JSON.stringify(value)
    case 'bigint':
      throw new TypeError('canonicalJson: BigInt is not allowed; convert it to decimal text first')
    case 'object': {
      if (seen.includes(value)) throw new TypeError('canonicalJson: circular structure')
      const next = [...seen, value]
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : write(v, next))).join(',')}]`
      }
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      const parts: string[] = []
      for (const k of keys) {
        const v = obj[k]
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
        parts.push(`${JSON.stringify(k)}:${write(v, next)}`)
      }
      return `{${parts.join(',')}}`
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`)
  }
}

const encoder = new TextEncoder()

/** SHA-256 of UTF-8 text or bytes, as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? encoder.encode(data) : data))
}

export interface IncrementalSha256 {
  update(bytes: Uint8Array): void
  digestHex(): string
}

/** SHA-256 fed chunk by chunk, so a file is hashed while it streams. */
export function createIncrementalSha256(): IncrementalSha256 {
  const h = sha256.create()
  let digest: string | null = null
  return {
    update(bytes) {
      if (digest !== null) throw new Error('Hash already finalized')
      h.update(bytes)
    },
    digestHex() {
      digest ??= bytesToHex(h.digest())
      return digest
    },
  }
}

/**
 * Calculation identity: SHA-256 of the canonical JSON of the validated inputs.
 * Unknown keys (such as an export time) are stripped by the schema, so they never change it.
 */
export function calculationIdentity(inputs: IdentityInputs): string {
  return sha256Hex(canonicalJson(IdentityInputs.parse(inputs)))
}

/** The adapters (id and version) used for a variant. */
export function adapterList(variant: VariantId): { id: string; version: string }[] {
  const a = adapterForVariant(variant)
  return [{ id: a.id, version: a.version }]
}
