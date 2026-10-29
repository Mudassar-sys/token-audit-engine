import { describe, expect, it } from 'vitest'
import {
  decimalToScaled,
  FEMTO_PER_USD,
  femtoToExactUsd,
  formatUsd,
  loggedNumberToDecimal,
  PrecisionError,
  rateToFemto,
  scaledToDecimal,
  tokensTimesRate,
  usdToFemto,
} from '../../src/engine/money'

describe('decimal parsing', () => {
  it('parses plain and scientific text without floats', () => {
    expect(rateToFemto('0.0000025')).toBe(2_500_000_000n)
    expect(rateToFemto('2.5e-06')).toBe(2_500_000_000n)
    expect(rateToFemto('2.5E-6')).toBe(2_500_000_000n)
    expect(rateToFemto('1e-05')).toBe(10_000_000_000n)
    expect(rateToFemto('.5')).toBe(500_000_000_000_000n)
    expect(rateToFemto('3.0e-7')).toBe(300_000_000n)
    expect(rateToFemto('0.000000150')).toBe(150_000_000n)
    expect(rateToFemto('0')).toBe(0n)
    expect(rateToFemto('0.0')).toBe(0n)
    expect(rateToFemto('1e-15')).toBe(1n)
    expect(rateToFemto('12')).toBe(12n * FEMTO_PER_USD)
    expect(rateToFemto('+1.5e2')).toBe(150n * FEMTO_PER_USD)
    expect(decimalToScaled('-0.25', 2)).toBe(-25n)
    expect(decimalToScaled(' 7 ', 0)).toBe(7n)
  })

  it('refuses to round: PrecisionError for digits finer than the scale', () => {
    expect(() => rateToFemto('2.857142857142857e-07')).toThrow(PrecisionError)
    expect(() => rateToFemto('1e-16')).toThrow(PrecisionError)
    expect(() => rateToFemto('0.0000000000000001')).toThrow(PrecisionError)
    expect(() => decimalToScaled('0.1234567', 6)).toThrow(PrecisionError)
    // Trailing zeros beyond the scale are not extra precision.
    expect(rateToFemto('0.0000000000000010000')).toBe(1n)
    try {
      rateToFemto('1e-16')
    } catch (e) {
      expect((e as Error).name).toBe('PrecisionError')
      expect((e as Error).message).toContain('1e-16')
    }
  })

  it('rejects text that is not a decimal', () => {
    for (const bad of ['', 'abc', '1.2.3', '0x10', 'NaN', 'Infinity', '1e', '--1']) {
      expect(() => rateToFemto(bad)).toThrow()
    }
  })

  it('renders exact decimal text with trailing zeros trimmed', () => {
    expect(scaledToDecimal(5_615_000_000_000n, 15)).toBe('0.005615')
    expect(scaledToDecimal(-1n, 15)).toBe('-0.000000000000001')
    expect(scaledToDecimal(0n, 15)).toBe('0')
    expect(femtoToExactUsd(1_000_000_000_000_000n)).toBe('1')
    expect(femtoToExactUsd(34_900_000_000_000n)).toBe('0.0349')
    expect(usdToFemto(femtoToExactUsd(123_456_789n))).toBe(123_456_789n)
  })
})

describe('formatUsd', () => {
  it('rounds half away from zero at the display precision', () => {
    expect(formatUsd(usdToFemto('0.0349'))).toBe('$0.034900')
    expect(formatUsd(usdToFemto('0.0000005'))).toBe('$0.000001')
    expect(formatUsd(usdToFemto('0.00000049'))).toBe('$0.000000')
    expect(formatUsd(usdToFemto('-0.0000005'))).toBe('-$0.000001')
    expect(formatUsd(usdToFemto('-0.0000001'))).toBe('$0.000000')
    expect(formatUsd(usdToFemto('0.125'), 2)).toBe('$0.13')
    expect(formatUsd(usdToFemto('0.124999'), 2)).toBe('$0.12')
    expect(formatUsd(usdToFemto('1.5'), 0)).toBe('$2')
  })

  it('groups thousands in the integer part only', () => {
    expect(formatUsd(usdToFemto('1234567.891'), 2)).toBe('$1,234,567.89')
    expect(formatUsd(usdToFemto('999.9999999'))).toBe('$1,000.000000')
    expect(formatUsd(usdToFemto('0.0012345'), 7)).toBe('$0.0012345')
    expect(formatUsd(1n, 15)).toBe('$0.000000000000001')
  })
})

describe('exact sums', () => {
  it('0.1 + 0.2 is exactly 0.3', () => {
    expect(femtoToExactUsd(usdToFemto('0.1') + usdToFemto('0.2'))).toBe('0.3')
  })

  it('a million small charges sum exactly', () => {
    let s = 0n
    const one = usdToFemto('0.000001')
    for (let i = 0; i < 1_000_000; i++) s += one
    expect(femtoToExactUsd(s)).toBe('1')
  })

  it('tokens times rate is exact and rejects bad counts', () => {
    expect(femtoToExactUsd(tokensTimesRate(86, rateToFemto('2.5e-06')))).toBe('0.000215')
    expect(femtoToExactUsd(tokensTimesRate(Number.MAX_SAFE_INTEGER, rateToFemto('1e-15')))).toBe('9.007199254740991')
    expect(() => tokensTimesRate(-1, 1n)).toThrow()
    expect(() => tokensTimesRate(1.5, 1n)).toThrow()
  })
})

describe('loggedNumberToDecimal', () => {
  it('keeps logged amounts as exact text', () => {
    expect(loggedNumberToDecimal(0.00014)).toBe('0.00014')
    expect(loggedNumberToDecimal('0.95')).toBe('0.95')
    expect(loggedNumberToDecimal(1e-7)).toBe('0.0000001')
    expect(loggedNumberToDecimal(0)).toBe('0')
    expect(loggedNumberToDecimal(null)).toBeNull()
    expect(loggedNumberToDecimal('')).toBeNull()
    expect(loggedNumberToDecimal('n/a')).toBeNull()
    expect(loggedNumberToDecimal(Number.NaN)).toBeNull()
    expect(() => loggedNumberToDecimal('1e-30')).toThrow(PrecisionError)
  })
})
