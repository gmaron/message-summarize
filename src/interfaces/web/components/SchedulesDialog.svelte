<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { formatDateTime, weekdayName } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import {
    EVERY_DAY,
    inUiOrder,
    newDraft,
    presetOf,
    type ScheduleDraft,
    scheduleIssueOf,
    toggleDay,
    UI_DAY_ORDER,
    validateDraft,
    WEEKDAYS,
  } from '../lib/schedules.js'
  import type { AccountView, ScheduleView, SchedulesView } from '../lib/types.js'
  import Modal from './Modal.svelte'

  let {
    api,
    texts,
    account,
    onclose,
  }: { api: Api; texts: WebTexts; account: AccountView; onclose: () => void } = $props()

  const t = $derived(texts.ui.schedules)
  // Only the id matters here: `account` is a new object on every `accounts` event, and the list must not be reloaded each time.
  const accountId = $derived(account.id)
  let loaded: SchedulesView | null = $state.raw(null)
  let loadError: string | null = $state(null)
  /** The schedule being edited: its id (null for a new one). */
  let editing: { id: number | null } | null = $state.raw(null)
  let draft: ScheduleDraft = $state.raw(newDraft())
  let problem: string | null = $state(null)
  let saving = $state(false)

  const codeOf = (error: unknown): string => (error instanceof ApiError ? error.code : 'internal')

  async function load(id: string) {
    try {
      loaded = await api.schedules(id)
      loadError = null
    } catch (error) {
      loadError = codeOf(error)
    }
  }
  $effect(() => {
    const id = accountId
    untrack(() => load(id))
  })

  function edit(schedule: ScheduleView | null) {
    editing = { id: schedule === null ? null : schedule.id }
    draft = schedule === null ? newDraft() : { days: [...schedule.days], time: schedule.time }
    problem = null
  }

  const failure = (error: unknown): string => {
    const issue = scheduleIssueOf(error)
    return issue !== null ? texts.scheduleIssues[issue] : errorText(codeOf(error), texts)
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    const issue = validateDraft(draft)
    if (issue !== null) {
      problem = texts.scheduleIssues[issue]
      return
    }
    if (editing === null) return
    saving = true
    problem = null
    try {
      const input = { days: [...draft.days], time: draft.time }
      if (editing.id === null) await api.addSchedule(accountId, input)
      else await api.updateSchedule(accountId, editing.id, input)
      editing = null
      await load(accountId)
    } catch (error) {
      problem = failure(error)
    } finally {
      saving = false
    }
  }

  async function remove(schedule: ScheduleView) {
    problem = null
    try {
      await api.deleteSchedule(accountId, schedule.id)
      if (editing?.id === schedule.id) editing = null
      await load(accountId)
    } catch (error) {
      problem = failure(error)
    }
  }

  const dayNames = (days: readonly number[]): string => {
    const preset = presetOf(days)
    if (preset !== null) return t[preset]
    return inUiOrder(days)
      .map((day) => weekdayName(day, texts.locale, 'short'))
      .join(', ')
  }
</script>

<Modal title={fmt(t.title, { account: account.id })} closeLabel={texts.ui.close} {onclose}>
  {#if loadError !== null}
    <p class="note error" role="alert">{errorText(loadError, texts)}</p>
  {:else if loaded === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    <p class="muted">{fmt(t.timezone, { timezone: loaded.timezone })}</p>

    {#if loaded.schedules.length === 0}
      <p>{t.empty}</p>
    {:else}
      <ul class="list">
        {#each loaded.schedules as schedule (schedule.id)}
          <li>
            <div class="what">
              <strong>{schedule.time}</strong>
              <span>{dayNames(schedule.days)}</span>
              {#if schedule.nextRun !== null}
                <span class="muted">{fmt(t.nextRun, { when: formatDateTime(schedule.nextRun, loaded.timezone, texts.locale) })}</span>
              {/if}
            </div>
            <div class="row-buttons">
              <button type="button" onclick={() => edit(schedule)}>{t.edit}</button>
              <button type="button" class="danger" onclick={() => remove(schedule)}>{t.delete}</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if editing === null}
      <div>
        <button type="button" class="primary" onclick={() => edit(null)}>{t.add}</button>
      </div>
    {:else}
      <form onsubmit={save}>
        <fieldset>
          <legend>{t.daysLabel}</legend>
          <div class="days">
            {#each UI_DAY_ORDER as day (day)}
              <label class="day">
                <input type="checkbox" checked={draft.days.includes(day)} onchange={() => (draft = toggleDay(draft, day))} />
                <span>{weekdayName(day, texts.locale, 'short')}</span>
              </label>
            {/each}
          </div>
          <div class="presets">
            <button type="button" onclick={() => (draft = { ...draft, days: [...EVERY_DAY] })}>{t.everyDay}</button>
            <button type="button" onclick={() => (draft = { ...draft, days: [...WEEKDAYS] })}>{t.weekdays}</button>
          </div>
        </fieldset>
        <label class="time">
          <span>{t.timeLabel}</span>
          <input
            type="time"
            value={draft.time}
            oninput={(event) => (draft = { ...draft, time: event.currentTarget.value })}
            required
          />
        </label>
        <div class="row-buttons">
          <button type="submit" class="primary" disabled={saving}>{saving ? t.saving : t.save}</button>
          <button type="button" onclick={() => ((editing = null), (problem = null))}>{texts.ui.cancel}</button>
        </div>
      </form>
    {/if}

    {#if problem !== null}
      <p class="note error" role="alert">{problem}</p>
    {/if}
  {/if}
</Modal>

<style>
  p {
    margin: 0;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  .list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
  }

  .what {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    align-items: baseline;
  }

  .row-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  form {
    display: grid;
    gap: 0.9rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.9rem;
  }

  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  legend {
    padding: 0;
    margin-bottom: 0.4rem;
    font-weight: 600;
  }

  .days,
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .day {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.55rem;
    cursor: pointer;
  }

  .day:has(input:checked) {
    border-color: var(--accent);
    background: var(--neutral-bg);
  }

  .time {
    display: grid;
    gap: 0.25rem;
    max-width: 10rem;
    font-weight: 600;
  }
</style>
