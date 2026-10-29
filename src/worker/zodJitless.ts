import { z } from 'zod'

/**
 * Turn off zod's compiled parsers before any schema is built in the worker.
 * Without this, zod probes `new Function('')` once, and the site's script-src policy
 * reports that probe as a violation even though zod catches the error.
 * The worker imports this module first.
 */
z.config({ jitless: true })
