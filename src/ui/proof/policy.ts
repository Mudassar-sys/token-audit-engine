/**
 * The response headers the site sends, copied from vercel.json so the privacy panel can show them.
 * A unit test fails when this copy and vercel.json differ.
 */
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  {
    key: 'Content-Security-Policy',
    value:
      "default-src 'self'; connect-src 'self'; script-src 'self'; worker-src 'self' blob:; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  },
  { key: 'X-Robots-Tag', value: 'noindex' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
]

/** The content security policy text, exactly as sent. */
export const CONTENT_SECURITY_POLICY = SECURITY_HEADERS.find((h) => h.key === 'Content-Security-Policy')?.value ?? ''

/** The policy split into its directives, in order. */
export function cspDirectives(policy: string = CONTENT_SECURITY_POLICY): string[] {
  return policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
}
