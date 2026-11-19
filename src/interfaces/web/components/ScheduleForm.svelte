<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { weekdayName } from '../lib/format.js'
  import { EVERY_DAY, presetOf, type ScheduleDraft, toggleDay, UI_DAY_ORDER, WEEKDAYS } from '../lib/schedules.js'

  // The days and the time of a schedule. The caller decides what saving it means; this only holds what is typed.
  let {
    texts,
    initial,
    submitLabel,
    busy = false,
    problem = null,
    onsubmit,
    oncancel,
    secondary,
  }: {
    texts: WebTexts
    initial: ScheduleDraft
    submitLabel: string
    busy?: boolean
    problem?: string | null
    onsubmit: (draft: ScheduleDraft) => void
    oncancel?: () => void
    /** Another button beside the submit one (the "set it up later" of the new account). */
    secondary?: { label: string; onclick: () => void }
  } = $props()

  const t = $derived(texts.ui.schedules)
  let draft: ScheduleDraft = $state.raw(untrack(() => initial))
  const id = `time-${Math.random().toString(36).slice(2, 8)}`
</script>

<form
  class="stack"
  onsubmit={(event) => {
    event.preventDefault()
    onsubmit(draft)
  }}
>
  <fieldset class="plain">
    <legend>{t.daysLabel}</legend>
    <div class="days">
      {#each UI_DAY_ORDER as day (day)}
        <label class="day">
          <input
            type="checkbox"
            checked={draft.days.includes(day)}
            aria-label={weekdayName(day, texts.locale, 'long')}
            onchange={() => (draft = toggleDay(draft, day))}
          />
          <span>{weekdayName(day, texts.locale, 'narrow')}</span>
        </label>
      {/each}
    </div>
    <div class="chips">
      <button
        type="button"
        class="chip"
        aria-pressed={presetOf(draft.days) === 'everyDay'}
        onclick={() => (draft = { ...draft, days: [...EVERY_DAY] })}
      >
        {t.everyDay}
      </button>
      <button
        type="button"
        class="chip"
        aria-pressed={presetOf(draft.days) === 'weekdays'}
        onclick={() => (draft = { ...draft, days: [...WEEKDAYS] })}
      >
        {t.weekdays}
      </button>
    </div>
  </fieldset>
  <div class="field w-200">
    <label for={id}>{t.timeLabel}</label>
    <input
      type="time"
      {id}
      value={draft.time}
      required
      oninput={(event) => (draft = { ...draft, time: event.currentTarget.value })}
    />
  </div>
  {#if problem !== null}
    <p class="err small bad-text" role="alert">{problem}</p>
  {/if}
  <div class="cluster">
    <button type="submit" class="btn primary" disabled={busy}>{busy ? t.saving : submitLabel}</button>
    {#if secondary !== undefined}
      <button type="button" class="btn quiet" onclick={secondary.onclick}>{secondary.label}</button>
    {/if}
    {#if oncancel !== undefined}
      <button type="button" class="btn quiet" onclick={oncancel}>{texts.ui.cancel}</button>
    {/if}
  </div>
</form>
