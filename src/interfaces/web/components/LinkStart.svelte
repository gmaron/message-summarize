<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { canStartLink, rememberRisk, riskAccepted } from '../lib/risk.js'

  // The legal notice and the button that starts linking a new account: the button waits for "I understand the risk".
  let { texts, onstart, idSuffix }: { texts: WebTexts; onstart: () => void; idSuffix: string } = $props()

  const t = $derived(texts.ui.risk)
  const storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  let checked = $state(riskAccepted(storage))

  function start() {
    if (!canStartLink(true, checked)) return
    rememberRisk(storage)
    onstart()
  }
</script>

<section class="notice warn" aria-labelledby={`risk-title-${idSuffix}`}>
  <h4 id={`risk-title-${idSuffix}`}>{t.heading}</h4>
  <ul>
    <li>{t.unofficial}</li>
    <li>{t.readOnly}</li>
    <li>{t.responsibility}</li>
    <li>{t.notAffiliated}</li>
  </ul>
  <p><a href={t.learnMoreUrl} target="_blank" rel="noopener noreferrer">{t.learnMore}</a></p>
</section>
<label class="check">
  <input type="checkbox" bind:checked />
  <span>{t.checkbox}</span>
</label>
<div class="cluster">
  <button type="button" class="btn primary" disabled={!canStartLink(true, checked)} onclick={start}>{t.start}</button>
</div>

<style>
  .notice {
    display: grid;
    gap: 0.5rem;
    text-align: left;
  }

  h4,
  p,
  ul {
    margin: 0;
  }

  ul {
    padding-left: 1.25rem;
    display: grid;
    gap: 0.35rem;
  }

  a {
    color: inherit;
  }
</style>
