import { z } from 'zod'

/**
 * Turn off zod's compiled parsers before any schema is built.
 * Without this, zod probes `new Function('')` once, and the site's script-src policy
 * reports that probe as a violation even though zod catches the error.
 * Import this module first in every entry point.
 */
z.config({ jitless: true })
