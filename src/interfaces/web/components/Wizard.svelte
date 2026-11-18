<script lang="ts">
  import { untrack } from 'svelte'
  import { SETUP_STEPS } from '../../../domain/setup.js'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { isAccountIdValid } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { dayLabel, newDraft, scheduleIssueOf, shortTime, validateDraft } from '../lib/schedules.js'
  import { issueReason, issuesOf, optionLabel } from '../lib/settings.js'
  import {
    DEFAULT_OLLAMA_URL,
    emptyDraft,
    consentKeyOf,
    hostOf,
    nameBody,
    nameIssue,
    previousStep,
    providerBody,
    providerIssue,
    stepIndicator,
    SUGGESTED_SCHEDULES,
    testBody,
    withBaseUrl,
    WIZARD_PROVIDERS,
    type WizardDraft,
  } from '../lib/setup.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, Language, SchedulesView, SetupStep, SetupView } from '../lib/types.js'
  import Disclosure from './Disclosure.svelte'
  import Icon from './Icon.svelte'
  import LinkView from './LinkView.svelte'
  import ProviderTest from './ProviderTest.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import ScheduleForm from './ScheduleForm.svelte'

  let {
    controller,
    api,
    texts,
    app,
    setup,
  }: { controller: Controller; api: Api; texts: WebTexts; app: AppState; setup: SetupView } = $props()

  const w = $derived(texts.ui.wizard)
  const step: SetupStep = $derived(setup.step)
  const total = SETUP_STEPS.length
  const account = $derived(setup.account)
  const accountView: AccountView | null = $derived(
    account === null ? null : (app.accounts?.find((row) => row.id === account) ?? null),
  )

  // What the user typed. It is restored from the daemon when the wizard is reopened (the account's own settings).
  let draft: WizardDraft = $state.raw(untrack(() => emptyDraft(app.language)))
  let saving = $state(false)
  let problem: string | null = $state(null)
  let issueLines: string[] = $state.raw([])
  let confirmSkip = $state(false)
  /** The schedule form (outside the wizard's own form: forms are never nested): null hidden, id null for a new schedule. */
  let editor: { id: number | null; initial: { days: readonly number[]; time: string } } | null = $state.raw(null)
  let scheduleProblem: string | null = $state(null)
  let removing: { id: number; time: string; days: readonly number[] } | null = $state.raw(null)
  let schedules: SchedulesView | null = $state.raw(null)

  const patch = (change: Partial<WizardDraft>): void => {
    draft = { ...draft, ...change }
    problem = null
    issueLines = []
  }

  // Reopened halfway: what was saved for the account fills the form again.
  let restored: string | null = null
  $effect(() => {
    const id = account
    if (id === null || restored === id) return
    restored = id
    untrack(async () => {
      try {
        const view = await api.settings(id)
        const provider = view.values.provider.primary
        patch({
          ownerName: view.values.ownerName ?? '',
          accountId: id,
          ...(provider === null
            ? {}
            : {
                provider,
                claudeModel: provider === 'claude-cli' ? view.values.provider.claudeCli.model : '',
                ollamaBaseUrl: view.values.provider.ollama.baseUrl,
                ollamaModel: view.values.provider.ollama.model ?? '',
              }),
        })
      } catch {
        // The form stays as it is: the user can fill it in again.
      }
    })
  })
  // The agreement already recorded for this account is shown as given.
  $effect(() => {
    const key = consentKeyOf(draft)
    const given = key !== null && setup.consents.includes(key)
    if (given && !draft.consent) untrack(() => patch({ consent: true }))
  })

  const nameProblem = $derived(nameIssue(draft, account !== null))
  const providerProblem = $derived(providerIssue(draft))
  const phase = $derived(account === null ? 'idle' : (app.links[account]?.phase ?? 'idle'))
  const linkBusy = $derived(['waitingQr', 'qr', 'syncing'].includes(phase))
  const linkFailed = $derived(account !== null && (app.links[account]?.requestError ?? null) !== null)
  /** 'linked': nothing to do, 'start': the QR is not asked for yet, 'progress': the QR, the sync or what went wrong. */
  const linkView: 'linked' | 'start' | 'progress' = $derived(
    setup.linked && !linkBusy && phase !== 'failed' ? 'linked' : phase === 'idle' && !linkFailed ? 'start' : 'progress',
  )

  // A link that just finished: the daemon says now that the account has its session.
  $effect(() => {
    if (account !== null && phase === 'done') untrack(() => controller.loadSetup())
  })
  // Reopened while a link was in progress: its state is asked for.
  $effect(() => {
    if (step === 'link' && account !== null && accountView?.state === 'linking' && app.links[account] === undefined) {
      untrack(() => controller.restoreLink(account))
    }
  })

  async function loadSchedules() {
    if (account === null) return
    try {
      schedules = await api.schedules(account)
    } catch {
      schedules = null
    }
  }
  $effect(() => {
    if ((step === 'schedule' || step === 'done') && account !== null) untrack(loadSchedules)
  })

  async function saveSchedule(next: { days: readonly number[]; time: string }) {
    if (account === null || editor === null) return
    const issue = validateDraft({ days: next.days, time: next.time })
    if (issue !== null) {
      scheduleProblem = texts.scheduleIssues[issue]
      return
    }
    saving = true
    scheduleProblem = null
    try {
      const input = { days: [...next.days], time: next.time }
      if (editor.id === null) await api.addSchedule(account, input)
      else await api.updateSchedule(account, editor.id, input)
      editor = null
      await loadSchedules()
    } catch (error) {
      const found = scheduleIssueOf(error)
      scheduleProblem =
        found !== null ? texts.scheduleIssues[found] : errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      saving = false
    }
  }

  async function removeSchedule() {
    const target = removing
    removing = null
    if (account === null || target === null) return
    try {
      await api.deleteSchedule(account, target.id)
      if (editor?.id === target.id) editor = null
      await loadSchedules()
    } catch (error) {
      problem = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    }
  }

  async function suggest() {
    if (account === null) return
    saving = true
    problem = null
    try {
      for (const one of SUGGESTED_SCHEDULES) await api.addSchedule(account, { days: [...one.days], time: one.time })
      await loadSchedules()
    } catch (error) {
      problem = errorText(error instanceof ApiError ? error.code : 'internal', texts)
    } finally {
      saving = false
    }
  }

  /** Saves a step (or goes back) and shows what the daemon refused with, if it did. */
  async function send(body: Record<string, unknown>): Promise<boolean> {
    saving = true
    problem = null
    issueLines = []
    const result = await controller.saveSetup(body)
    saving = false
    if (result.ok) return true
    const error = result.error
    const issues = issuesOf(error)
    if (issues !== null) {
      issueLines = issues.map((issue) =>
        fmt(texts.ui.settings.issue, { option: optionLabel(issue.option, texts), reason: issueReason(issue, texts) }),
      )
    } else if (error?.code === 'consentRequired') problem = texts.ui.disclosure.consentNeeded
    else problem = errorText(error?.code ?? 'internal', texts)
    return false
  }

  async function next(event?: SubmitEvent) {
    event?.preventDefault()
    if (saving) return
    switch (step) {
      case 'language':
        await send({ from: 'language', language: draft.language })
        break
      case 'name':
        if (nameProblem === null) await send(nameBody(draft, account !== null))
        break
      case 'provider':
        if (providerProblem === null) await send(providerBody(draft))
        break
      default:
        await send({ from: step })
    }
  }

  async function back() {
    const target = previousStep(step)
    if (target !== null && !saving) await send({ goto: target })
  }

  async function skip() {
    saving = true
    const result = await controller.skipSetup()
    saving = false
    if (!result.ok) problem = errorText(result.error?.code ?? 'internal', texts)
  }

  function startLink() {
    if (account !== null) void controller.startLink(account)
  }

  const nameProblemText = (code: NonNullable<typeof nameProblem>): string =>
    code === 'invalidAccountId' ? texts.errors.invalidAccountId : texts.ui.wizard.name[code]
  const providerName = (name: string): string =>
    (texts.ui.disclosure.providers as Record<string, { name: string }>)[name]?.name ?? name
  const consentKey = $derived(consentKeyOf(draft))
  /** The host of an Ollama that is not on this machine (the text goes there), or null. */
  const remoteHost = $derived(consentKey === 'ollama-remote' ? hostOf(draft.ollamaBaseUrl.trim() === '' ? DEFAULT_OLLAMA_URL : draft.ollamaBaseUrl) : null)
  const canContinue = $derived(
    step === 'link' ? setup.linked && !linkBusy : step === 'name' ? nameProblem === null : step === 'provider' ? providerProblem === null : true,
  )
</script>

<div class="wizard-page">
  <div class="head">
    <h1>{w.title}</h1>
    <span class="muted small">{fmt(w.stepOf, { n: SETUP_STEPS.indexOf(step) + 1, total })}</span>
  </div>

  <ol class="stepper" aria-label={w.stepsLabel}>
    {#each stepIndicator(step) as item (item.step)}
      <li class:done={item.state === 'done'} aria-current={item.state === 'current' ? 'step' : undefined}>
        <span class="n">{#if item.state === 'done'}<Icon name="check" size={14} />{:else}{item.number}{/if}</span>{w.steps[item.step]}
      </li>
    {/each}
  </ol>

  <form class="form-section" onsubmit={next}>
    {#if step === 'language'}
      <h2>{w.language.heading}</h2>
      <p>{w.language.intro}</p>
      <div class="field w-200">
        <label for="wizard-language">{w.language.label}</label>
        <select
          id="wizard-language"
          value={draft.language}
          onchange={(event) => {
            const language = event.currentTarget.value as Language
            patch({ language })
            controller.setLanguage(language)
          }}
        >
          {#each ['es', 'en'] as const as language (language)}
            <option value={language}>{texts.ui.settings.languageNames[language]}</option>
          {/each}
        </select>
      </div>
    {:else if step === 'name'}
      <h2>{w.name.heading}</h2>
      <p>{w.name.intro}</p>
      <div class="field">
        <label for="wizard-owner">{w.name.ownerLabel}</label>
        <input
          id="wizard-owner"
          type="text"
          value={draft.ownerName}
          oninput={(event) => patch({ ownerName: event.currentTarget.value })}
          autocomplete="off"
          maxlength="80"
          aria-describedby="owner-hint"
        />
        <span class="hint" id="owner-hint">{w.name.ownerHint}</span>
      </div>
      <div class="field">
        <label for="wizard-account">{w.name.accountLabel}</label>
        <input
          id="wizard-account"
          type="text"
          value={draft.accountId}
          oninput={(event) => patch({ accountId: event.currentTarget.value })}
          disabled={account !== null}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="32"
          aria-describedby="account-hint"
        />
        <span class="hint" id="account-hint">{account !== null ? w.name.accountLocked : w.name.accountHint}</span>
      </div>
      {#if draft.ownerName !== '' && nameProblem !== null}
        <p class="err small bad-text" role="alert">{nameProblemText(nameProblem)}</p>
      {:else if account === null && draft.accountId !== '' && !isAccountIdValid(draft.accountId.trim())}
        <p class="err small bad-text" role="alert">{texts.errors.invalidAccountId}</p>
      {/if}
    {:else if step === 'provider'}
      <h2>{w.provider.heading}</h2>
      <p>{w.provider.intro}</p>
      <p class="muted small">{w.provider.laterNote}</p>
      <fieldset class="plain">
        <legend class="sr">{w.provider.heading}</legend>
        {#each WIZARD_PROVIDERS as provider (provider)}
          <div class="choice" class:chosen={draft.provider === provider}>
            <label class="radio">
              <input
                type="radio"
                name="provider"
                value={provider}
                checked={draft.provider === provider}
                onchange={() => patch({ provider, consent: false })}
              />
              <span>{providerName(provider)}</span>
            </label>
            {#if draft.provider === provider}
              <Disclosure {texts} {provider} host={remoteHost ?? undefined} />
              {#if provider === 'claude-cli'}
                <div class="field">
                  <label for="wizard-claude-model">{w.provider.modelLabel}</label>
                  <input
                    id="wizard-claude-model"
                    type="text"
                    value={draft.claudeModel}
                    oninput={(event) => patch({ claudeModel: event.currentTarget.value })}
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="sonnet"
                  />
                </div>
              {:else}
                <div class="field">
                  <label for="wizard-ollama-url">{w.provider.baseUrlLabel}</label>
                  <input
                    id="wizard-ollama-url"
                    type="text"
                    value={draft.ollamaBaseUrl}
                    oninput={(event) => {
                      draft = withBaseUrl(draft, event.currentTarget.value)
                      problem = null
                      issueLines = []
                    }}
                    autocomplete="off"
                    spellcheck="false"
                  />
                </div>
                <div class="field">
                  <label for="wizard-ollama-model">{w.provider.ollamaModelLabel}</label>
                  <input
                    id="wizard-ollama-model"
                    type="text"
                    value={draft.ollamaModel}
                    oninput={(event) => patch({ ollamaModel: event.currentTarget.value })}
                    autocomplete="off"
                    spellcheck="false"
                    aria-describedby="ollama-model-hint"
                  />
                  <span class="hint" id="ollama-model-hint">{w.provider.ollamaModelHint}</span>
                </div>
              {/if}
              {#if consentKey !== null}
                <label class="check">
                  <input
                    type="checkbox"
                    checked={draft.consent}
                    onchange={(event) => patch({ consent: event.currentTarget.checked })}
                  />
                  <span>{fmt(texts.ui.disclosure.consentCheckbox, { provider: remoteHost ?? providerName(provider) })}</span>
                </label>
              {/if}
              <ProviderTest {api} {texts} body={testBody(draft)} blocked={providerProblem !== null} />
              {#if providerProblem === 'consent'}
                <p class="muted small">{texts.ui.disclosure.test.needsConsent}</p>
              {/if}
            {/if}
          </div>
        {/each}
      </fieldset>
    {:else if step === 'transcription'}
      <h2>{w.transcription.heading}</h2>
      <p>{w.transcription.text}</p>
    {:else if step === 'link'}
      <h2>{w.link.heading}</h2>
      <p>{w.link.intro}</p>
      {#if account !== null}
        {#if linkView === 'linked'}
          <p class="notice ok">{texts.ui.link.done}</p>
        {:else if linkView === 'start'}
          <div><button type="button" class="btn primary" onclick={startLink}>{w.link.start}</button></div>
        {:else}
          <LinkView {controller} {api} {texts} id={account} link={app.links[account]} oncancel={() => undefined} />
        {/if}
        {#if !setup.linked}
          <p class="muted small">{w.link.needsLink}</p>
        {/if}
      {/if}
    {:else if step === 'schedule'}
      <h2>{w.schedule.heading}</h2>
      <p>{w.schedule.intro}</p>
      {#if schedules !== null}
        <p class="muted small">{fmt(w.schedule.timezone, { timezone: schedules.timezone })}</p>
        <h3>{w.schedule.current}</h3>
        {#if schedules.schedules.length === 0}
          <p>{w.schedule.none}</p>
        {:else}
          <ul class="list">
            {#each schedules.schedules as one (one.id)}
              <li class="sched">
                <div>
                  <div class="t num">{shortTime(one.time)}</div>
                  <div class="small muted">{dayLabel(one.days, texts)}</div>
                </div>
                <div class="cluster">
                  <button
                    type="button"
                    class="btn quiet sm"
                    onclick={() => ((editor = { id: one.id, initial: { days: one.days, time: one.time } }), (scheduleProblem = null))}
                  >
                    {texts.ui.schedules.edit}
                  </button>
                  <button
                    type="button"
                    class="btn quiet sm danger"
                    aria-label={fmt(texts.ui.schedules.deleteLabel, { time: shortTime(one.time) })}
                    onclick={() => (removing = { id: one.id, time: one.time, days: one.days })}
                  >
                    {texts.ui.schedules.delete}
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
      <div class="cluster">
        {#if schedules !== null && schedules.schedules.length === 0}
          <button type="button" class="btn primary" onclick={suggest} disabled={saving}>{w.schedule.suggest}</button>
        {/if}
        <button
          type="button"
          class="btn"
          onclick={() => ((editor = { id: null, initial: newDraft() }), (scheduleProblem = null))}
        >
          {texts.ui.schedules.addTitle}
        </button>
      </div>
      <p class="muted small">{w.schedule.skipNote}</p>
    {:else}
      <h2>{w.done.heading}</h2>
      <p>{w.done.text}</p>
      {#if schedules !== null && schedules.schedules.length === 0}
        <p class="notice warn" role="status">{w.done.noSchedule}</p>
      {/if}
    {/if}

    {#if issueLines.length > 0}
      <ul class="notice bad" role="alert">
        {#each issueLines as line (line)}
          <li>{line}</li>
        {/each}
      </ul>
    {/if}
    {#if problem !== null}
      <p class="notice bad" role="alert">{problem}</p>
    {/if}

    <div class="cluster">
      {#if previousStep(step) !== null}
        <button type="button" class="btn" onclick={back} disabled={saving}>{w.back}</button>
      {/if}
      <button type="submit" class="btn primary" disabled={saving || !canContinue}>
        {saving ? w.saving : step === 'done' ? w.done.finish : w.next}
      </button>
    </div>
  </form>

  {#if step === 'schedule' && editor !== null}
    {#key `${editor.id}`}
      <section class="form-section" aria-labelledby="wizard-schedule-form">
        <h2 id="wizard-schedule-form">{editor.id === null ? texts.ui.schedules.addTitle : texts.ui.schedules.editTitle}</h2>
        <ScheduleForm
          {texts}
          initial={editor.initial}
          submitLabel={editor.id === null ? texts.ui.schedules.add : texts.ui.schedules.save}
          busy={saving}
          problem={scheduleProblem}
          onsubmit={(next) => void saveSchedule(next)}
          oncancel={() => ((editor = null), (scheduleProblem = null))}
        />
      </section>
    {/key}
  {/if}

  <div class="stack-sm">
    {#if confirmSkip}
      <p class="notice warn" role="alert">{w.skipConfirm}</p>
      <div class="cluster">
        <button type="button" class="btn danger" onclick={skip} disabled={saving}>{w.skipYes}</button>
        <button type="button" class="btn" onclick={() => (confirmSkip = false)}>{w.skipNo}</button>
      </div>
    {:else}
      <div><button type="button" class="linklike" onclick={() => (confirmSkip = true)}>{w.skip}</button></div>
    {/if}
  </div>
</div>

{#if removing !== null}
  <ConfirmDialog
    title={texts.ui.schedules.deleteTitle}
    confirmLabel={texts.ui.schedules.delete}
    cancelLabel={texts.ui.cancel}
    tone="danger"
    onconfirm={removeSchedule}
    oncancel={() => (removing = null)}
  >
    <p>{fmt(texts.ui.schedules.deleteText, { time: shortTime(removing.time), days: dayLabel(removing.days, texts) })}</p>
  </ConfirmDialog>
{/if}
