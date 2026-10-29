import { useId } from 'react'

/** Short methodology: how tokens are read, how values are labelled, and what the demo does not establish. */
export function MethodologyPage() {
  const ids = useId()
  return (
    <section aria-labelledby={`${ids}-h`} className="prose">
      <h2 id={`${ids}-h`}>Methodology</h2>

      <h3>Token classes</h3>
      <p>
        Every row is reduced to the same classes: uncached input, cache read, cache write (5 minutes, 1 hour, 30 minutes or 12 hours), and output.
        Reasoning tokens are a part of output and are never added on top. Audio, image and video tokens, web search requests, tool sessions and storage are
        counted and shown, but never folded into token cost.
      </p>

      <h3>Rules per source</h3>
      <ul>
        <li>
          <strong>OpenAI Chat Completions.</strong> Uncached input is prompt tokens minus cached tokens minus cache write tokens, minus audio and image tokens.
          Writes have no stated duration, so 30 minutes is assumed and flagged.
        </li>
        <li>
          <strong>OpenAI Responses.</strong> Uncached input is input tokens minus cached and cache write tokens. Writes split into 30 minutes and 12 hours when the
          breakdown is present.
        </li>
        <li>
          <strong>OpenAI Usage API pages.</strong> One row per time bucket and result. Totals are used before breakdowns and are never subtracted together with them.
          A total that disagrees with its full breakdown is Unresolved.
        </li>
        <li>
          <strong>Anthropic Messages.</strong> Input tokens already exclude the cache. Writes split into 5 minutes and 1 hour; a write without a breakdown is
          treated as 5 minutes and flagged.
        </li>
        <li>
          <strong>OpenRouter.</strong> The logged cost is a Measured charge. With your own provider key, the upstream cost is added exactly.
        </li>
        <li>
          <strong>LiteLLM spend logs.</strong> Whether prompt tokens include cache hits is decided once per file from the first 5,000 rows. Logged spend is the
          gateway's own calculation, shown beside the snapshot estimate.
        </li>
        <li>
          <strong>OpenTelemetry spans.</strong> Inference spans are counted. Agent and workflow spans with usage are kept only to reconcile their children. A span whose
          cache tokens exceed its input is Unresolved.
        </li>
        <li>
          <strong>Any other CSV.</strong> You map the columns. Columns you leave out are Not measured.
        </li>
      </ul>

      <h3>Labels</h3>
      <dl className="kv">
        <dt>Measured</dt>
        <dd>A token count as logged in the named field.</dd>
        <dt>Measured charge</dt>
        <dd>A billed amount logged by the source.</dd>
        <dt>Estimated</dt>
        <dd>Tokens times the snapshot list price, or a gateway's own calculation.</dd>
        <dt>Not measured</dt>
        <dd>The source does not carry this value.</dd>
        <dt>Not priced</dt>
        <dd>The model or a needed rate is not in the snapshot. The row has no value and the total is marked partial.</dd>
        <dt>Unresolved</dt>
        <dd>The row contradicts itself or a documented rule. It has no value until reviewed.</dd>
      </dl>

      <h3>Three kinds of zero</h3>
      <ul>
        <li>
          <strong>A valid zero.</strong> Every rate used is explicitly zero in the snapshot, or the source logged a charge of zero.
        </li>
        <li>
          <strong>Not priced.</strong> The model is not in the snapshot. The value is missing, not zero.
        </li>
        <li>
          <strong>Unresolved.</strong> A gateway logged spend of zero while the snapshot rate is not zero. It needs review.
        </li>
      </ul>

      <h3>Pricing snapshot</h3>
      <p>
        Prices come from a dated snapshot of the LiteLLM model price registry, stored with this site and checked against its SHA-256 before use. Rates are kept as
        exact decimal text and multiplied with whole numbers, so no value is rounded until display. An audit keeps the snapshot it used; a newer snapshot never
        recalculates it. These are current list prices, not negotiated or historical prices.
      </p>

      <h3>What this demo does not establish</h3>
      <p>Fit to a specific company's exports is proven only when its sample logs run through it.</p>
      <p>
        The savings modeller reprices logged tokens under assumptions you supply. It does not measure the quality of another model, and the baseline never ran.
      </p>
    </section>
  )
}
