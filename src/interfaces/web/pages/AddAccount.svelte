<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import Icon from '../components/Icon.svelte'
  import LinkStart from '../components/LinkStart.svelte'
  import LinkView from '../components/LinkView.svelte'
  import ScheduleForm from '../components/ScheduleForm.svelte'
  import { isAccountIdValid } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { linkNotStarted } from '../lib/risk.js'
  import { hrefOf } from '../lib/router.js'
  import { newDraft, type ScheduleDraft, scheduleIssueOf, validateDraft } from '../lib/schedules.js'
  import type { AppState } from '../lib/state.js'

  // Agregar cuenta: name it, link it, wait for the history, set the first schedule. The account is created at the first
  // step; what is left (linking, a schedule) can also be done later from its own pages.
  let { app, api, texts, controller }: { app: AppState; api: Api; texts: WebTexts; controller: Controller } = $props()

  const t = $derived(texts.ui.addAccount)
  let name = $state('')
  /** The account once it is created: from there on the page follows its link. */
  let created: string | null = $state(null)
  let code: string | null = $state(null)
  let sending = $state(false)
  let problem: string | null = $state(null)
  let saving = $state(false)

  // What is typed is checked as the daemon checks it; nothing is asked of the daemon until it is valid.
  const valid = $derived(isAccountIdValid(name))
  const shown = $derived(
    code !== null ? errorText(code, texts) : name !== '' && !valid ? texts.errors.invalidAccountId : null,
  )
  const phase = $derived(created === null ? 'idle' : (app.links[created]?.phase ?? 'idle'))
  const step = $derived(created === null ? 0 : phase === 'done' ? 3 : phase === 'syncing' ? 2 : 1)
  const steps = $derived([t.steps.name, t.steps.link, t.steps.sync, t.steps.schedule])

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!valid || sending) return
    sending = true
    code = null
    const result = await controller.addAccount(name)
    sending = false
    if (!result.ok) {
      code = result.code
      return
    }
    // The link starts when the legal notice is accepted (LinkStart), not when the account is created.
    created = name
  }

  const open = (id: string): void => {
    location.hash = hrefOf({ name: 'account', id, tab: 'resumen' })
  }

  async function finish(draft: ScheduleDraft) {
    if (created === null) return
    const issue = validateDraft(draft)
    if (issue !== null) {
      problem = texts.scheduleIssues[issue]
      return
    }
    saving = true
    problem = null
    try {
      await api.addSchedule(created, { days: [...draft.days], time: draft.time })
      open(created)
    } catch (error) {
      const found = scheduleIssueOf(error)
      problem = found !== null ? texts.scheduleIssues[found] : errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      saving = false
    }
  }
</script>

<div class="page-inner">
  <div class="head"><h1>{t.button}</h1></div>
  <ol class="stepper" aria-label={t.stepsLabel}>
    {#each steps as label, index (index)}
      <li class:done={index < step} aria-current={index === step ? 'step' : undefined}>
        <span class="n">{#if index < step}<Icon name="check" size={14} />{:else}{index + 1}{/if}</span>{label}
      </li>
    {/each}
  </ol>

  {#if step === 0}
    <form class="form-section narrow" onsubmit={submit}>
      <div class="field">
        <label for="new-account-id">{t.idLabel}</label>
        <input
          id="new-account-id"
          type="text"
          bind:value={name}
          oninput={() => (code = null)}
          placeholder={t.idPlaceholder}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="32"
          aria-describedby="new-account-hint"
          aria-invalid={shown !== null}
        />
        {#if shown !== null}
          <span class="err" id="new-account-hint" role="alert">{shown}</span>
        {:else}
          <span class="hint" id="new-account-hint">{t.idHint}</span>
        {/if}
      </div>
      <div><button type="submit" class="btn primary" disabled={!valid || sending}>{t.submit}</button></div>
    </form>
  {:else if step < 3 && created !== null && linkNotStarted(app.links[created])}
    <LinkStart {texts} idSuffix="add-account" onstart={() => void controller.startLink(created ?? '')} />
  {:else if step < 3 && created !== null}
    <LinkView {controller} {api} {texts} id={created} link={app.links[created]} oncancel={() => open(created ?? '')} />
  {:else if created !== null}
    <section class="form-section narrow" aria-labelledby="first-schedule">
      <h2 id="first-schedule">{t.scheduleTitle}</h2>
      <ScheduleForm
        {texts}
        initial={newDraft()}
        submitLabel={t.finish}
        busy={saving}
        {problem}
        onsubmit={(draft) => void finish(draft)}
        secondary={{ label: t.later, onclick: () => open(created ?? '') }}
      />
    </section>
  {/if}
</div>
