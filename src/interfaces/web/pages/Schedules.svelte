<script lang="ts">
  import { untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import AccountHeader from '../components/AccountHeader.svelte'
  import ConfigNotice from '../components/ConfigNotice.svelte'
  import ConfirmDialog from '../components/ConfirmDialog.svelte'
  import Icon from '../components/Icon.svelte'
  import ScheduleForm from '../components/ScheduleForm.svelte'
  import { accountActions, isDigestRunning } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { isUtcZone, whenText } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import { dayLabel, newDraft, type ScheduleDraft, scheduleIssueOf, shortTime, validateDraft } from '../lib/schedules.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, ScheduleView, SchedulesView } from '../lib/types.js'

  // Horarios: when the digest goes out. Adding, editing and deleting go through the daemon, which checks every schedule.
  let {
    app,
    api,
    texts,
    account,
    now,
  }: { app: AppState; api: Api; texts: WebTexts; account: AccountView; now: number } = $props()
  const usable = $derived(accountActions(account).schedules)

  const t = $derived(texts.ui.schedules)
  // Only the id matters here: `account` is a new object on every `accounts` event, and the list must not be reloaded each time.
  const accountId = $derived(account.id)
  const running = $derived(isDigestRunning(app.digests[account.id]))
  let loaded: SchedulesView | null = $state.raw(null)
  let loadError: string | null = $state(null)
  /** The schedule being edited: its id (null for a new one, which is what the form is for when nothing is edited). */
  let editing: { id: number | null } = $state.raw({ id: null })
  /** Changes when a form is over, so the next one starts from its own values. */
  let version = $state(0)
  let draft: ScheduleDraft = $state.raw(newDraft())
  let problem: string | null = $state(null)
  let saving = $state(false)
  let removing: ScheduleView | null = $state.raw(null)

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
    if (untrack(() => usable)) untrack(() => load(id))
  })

  const failure = (error: unknown): string => {
    const issue = scheduleIssueOf(error)
    return issue !== null ? texts.scheduleIssues[issue] : errorText(codeOf(error), texts)
  }

  function edit(schedule: ScheduleView | null) {
    editing = { id: schedule === null ? null : schedule.id }
    draft = schedule === null ? newDraft() : { days: [...schedule.days], time: schedule.time }
    problem = null
  }

  function cancelEdit() {
    editing = { id: null }
    draft = newDraft()
    problem = null
    version++
  }

  async function save(next: ScheduleDraft) {
    const issue = validateDraft(next)
    if (issue !== null) {
      problem = texts.scheduleIssues[issue]
      return
    }
    saving = true
    problem = null
    try {
      const input = { days: [...next.days], time: next.time }
      if (editing.id === null) await api.addSchedule(accountId, input)
      else await api.updateSchedule(accountId, editing.id, input)
      editing = { id: null }
      draft = newDraft()
      version++
      await load(accountId)
    } catch (error) {
      problem = failure(error)
    } finally {
      saving = false
    }
  }

  async function remove() {
    const schedule = removing
    removing = null
    if (schedule === null) return
    problem = null
    try {
      await api.deleteSchedule(accountId, schedule.id)
      if (editing.id === schedule.id) cancelEdit()
      await load(accountId)
    } catch (error) {
      problem = failure(error)
    }
  }

  // The next occurrence of each schedule, soonest first.
  const upcoming = $derived.by(() =>
    [...(loaded?.schedules ?? [])]
      .filter((one): one is ScheduleView & { nextRun: number } => one.nextRun !== null)
      .sort((a, b) => a.nextRun - b.nextRun),
  )
  const paused = $derived(account.state === 'blocked')
  const isEdit = $derived(editing.id !== null)
  const formKey = $derived(`${editing.id}-${version}`)
</script>

<div class="page-inner">
  <AccountHeader {account} {texts} tab="horarios" {running} />
  {#if !usable}
    <ConfigNotice {texts} {account} />
  {:else if loadError !== null}
    <div class="notice bad" role="alert">{errorText(loadError, texts)}</div>
  {:else if loaded === null}
    <p class="muted" role="status">{texts.ui.loading}</p>
  {:else}
    <div class="split">
      <div class="stack">
        <p class="small muted">
          {fmt(t.zoneLine, { zone: loaded.timezone })}{#if isUtcZone(loaded.timezone)} {t.zoneUtcHint}{/if}
        </p>
        <ul class="list">
          {#if loaded.schedules.length === 0}
            <li class="empty">
              <h2>{t.emptyTitle}</h2>
              <p>{t.empty}</p>
            </li>
          {:else}
            {#each loaded.schedules as schedule (schedule.id)}
              <li class="sched">
                <div>
                  <div class="t num">{shortTime(schedule.time)}</div>
                  <div class="small muted">
                    {dayLabel(schedule.days, texts)}
                    {#if schedule.nextRun !== null}{texts.ui.text.separator}{fmt(t.nextRun, { when: whenText(schedule.nextRun, loaded.timezone, texts.locale, now) })}{/if}
                  </div>
                </div>
                <div class="cluster">
                  <button type="button" class="btn quiet sm" onclick={() => edit(schedule)}>{t.edit}</button>
                  <button
                    type="button"
                    class="btn quiet sm danger"
                    aria-label={fmt(t.deleteLabel, { time: shortTime(schedule.time) })}
                    onclick={() => (removing = schedule)}
                  >
                    <Icon name="trash" />{t.delete}
                  </button>
                </div>
              </li>
            {/each}
          {/if}
        </ul>

        <section class="form-section" aria-labelledby="sched-form-title">
          <h2 id="sched-form-title">{isEdit ? t.editTitle : t.addTitle}</h2>
          {#key formKey}
            <ScheduleForm
              {texts}
              initial={draft}
              submitLabel={isEdit ? t.save : t.add}
              busy={saving}
              {problem}
              onsubmit={(next) => void save(next)}
              oncancel={isEdit ? cancelEdit : undefined}
            />
          {/key}
        </section>
      </div>

      <aside class="side">
        <div class="panel">
          <h3>{t.upcoming}</h3>
          <div class="next-runs num">
            {#if paused}
              <p class="small muted">{t.paused}</p>
            {:else if upcoming.length === 0}
              <p class="small muted">{texts.ui.account.noSchedules}</p>
            {:else}
              {#each upcoming as one (one.id)}
                <div class="item"><span>{whenText(one.nextRun, loaded.timezone, texts.locale, now)}</span></div>
              {/each}
            {/if}
          </div>
        </div>
      </aside>
    </div>
  {/if}
</div>

{#if removing !== null}
  <ConfirmDialog
    title={t.deleteTitle}
    confirmLabel={t.delete}
    cancelLabel={texts.ui.cancel}
    tone="danger"
    onconfirm={remove}
    oncancel={() => (removing = null)}
  >
    <p>{fmt(t.deleteText, { time: shortTime(removing.time), days: dayLabel(removing.days, texts) })}</p>
  </ConfirmDialog>
{/if}
