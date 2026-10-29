/**
 * Exact money math. Rates and amounts are BigInt femto-dollars (1 USD = 10^15 femto).
 * Rates come in as decimal text and never pass through a float.
 */

export const FEMTO_DIGITS = 15
export const FEMTO_PER_USD = 10n ** BigInt(FEMTO_DIGITS)

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$|^([+-])?\.(\d+)(?:[eE]([+-]?\d+))?$/

export class PrecisionError extends Error {
  constructor(text: string, scaleDigits: number) {
    super(`Decimal "${text}" needs more precision than 1e-${scaleDigits}; refusing to round`)
    this.name = 'PrecisionError'
  }
}

/**
 * Parse decimal text (plain or scientific) into an integer scaled by 10^scaleDigits.
 * Throws PrecisionError when the value has digits finer than the scale.
 */
export function decimalToScaled(text: string, scaleDigits: number): bigint {
  const t = text.trim()
  const m = DECIMAL_RE.exec(t)
  if (!m) throw new Error(`Not a decimal number: "${text}"`)
  const sign = m[1] ?? m[5] ?? '+'
  const intPart = m[2] ?? '0'
  const fracPart = m[3] ?? m[6] ?? ''
  const exp = parseInt(m[4] ?? m[7] ?? '0', 10)
  let digits = (intPart + fracPart).replace(/^0+(?=\d)/, '')
  // value = digits * 10^(exp - fracPart.length)
  const pow = exp - fracPart.length + scaleDigits
  if (pow >= 0) {
    digits = digits + '0'.repeat(pow)
  } else {
    const cut = -pow
    const keep = digits.length - cut
    const dropped = keep > 0 ? digits.slice(keep) : digits.padStart(cut, '0')
    if (/[1-9]/.test(dropped)) throw new PrecisionError(text, scaleDigits)
    digits = keep > 0 ? digits.slice(0, keep) : '0'
  }
  const v = BigInt(digits === '' ? '0' : digits)
  return sign === '-' ? -v : v
}

/** USD-per-token decimal text to femto-dollars per token. */
export function rateToFemto(text: string): bigint {
  return decimalToScaled(text, FEMTO_DIGITS)
}

/** Render a scaled integer as exact decimal text with trailing zeros trimmed. */
export function scaledToDecimal(value: bigint, scaleDigits: number): string {
  const neg = value < 0n
  const abs = neg ? -value : value
  const s = abs.toString().padStart(scaleDigits + 1, '0')
  const int = s.slice(0, s.length - scaleDigits)
  const frac = s.slice(s.length - scaleDigits).replace(/0+$/, '')
  const out = frac ? `${int}.${frac}` : int
  return neg && out !== '0' ? `-${out}` : out
}

/** Exact USD text of a femto amount, for example "0.005615". */
export function femtoToExactUsd(femto: bigint): string {
  return scaledToDecimal(femto, FEMTO_DIGITS)
}

/** USD decimal text to femto (amounts such as a reported charge). */
export function usdToFemto(text: string): bigint {
  return decimalToScaled(text, FEMTO_DIGITS)
}

/**
 * Display rounding only, half away from zero, with a fixed number of decimals.
 * The exact value is kept beside it in exports.
 */
export function formatUsd(femto: bigint, decimals = 6): string {
  const neg = femto < 0n
  const abs = neg ? -femto : femto
  const drop = FEMTO_DIGITS - decimals
  let q: bigint
  if (drop > 0) {
    const div = 10n ** BigInt(drop)
    q = abs / div
    if ((abs % div) * 2n >= div) q += 1n
  } else {
    q = abs * 10n ** BigInt(-drop)
  }
  const s = q.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals)
  // Thousands separators go in the integer part only.
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = decimals > 0 ? `${grouped}.${frac}` : grouped
  return `${neg && q !== 0n ? '-' : ''}$${body}`
}

/** Token count times a femto rate. Tokens are integers, so this is exact. */
export function tokensTimesRate(tokens: number, rateFemto: bigint): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error(`Invalid token count: ${tokens}`)
  return BigInt(tokens) * rateFemto
}

/**
 * Turn a logged amount (JSON number or text) into plain decimal text without rounding.
 * A JSON number is taken from its shortest round-trip text. Returns null when absent or not a number.
 * Throws PrecisionError when the amount is finer than 1e-24 USD.
 */
export function loggedNumberToDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  let text: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    text = String(value)
  } else if (typeof value === 'string' && DECIMAL_RE.test(value.trim())) {
    text = value.trim()
  } else {
    return null
  }
  return scaledToDecimal(decimalToScaled(text, 24), 24)
}
