<script lang="ts">
  import { untrack } from 'svelte'
  import { SETUP_STEPS } from '../../../domain/setup.js'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { isAccountIdValid } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { fmt } from '../lib/i18n.js'
  import { dayLabel } from '../lib/schedules.js'
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
  import LinkView from './LinkView.svelte'
  import ProviderTest from './ProviderTest.svelte'
  import SchedulesDialog from './SchedulesDialog.svelte'

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
  let showSchedules = $state(false)
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

<section class="wizard" aria-labelledby="wizard-title">
  <div class="head">
    <h2 id="wizard-title">{w.title}</h2>
    <p class="muted">{fmt(w.stepOf, { n: SETUP_STEPS.indexOf(step) + 1, total })}</p>
  </div>

  <ol class="steps" aria-label={w.stepsLabel}>
    {#each stepIndicator(step) as item (item.step)}
      <li class={item.state} aria-current={item.state === 'current' ? 'step' : undefined}>
        <span class="num">{item.number}</span>
        <span class="name">{w.steps[item.step]}</span>
      </li>
    {/each}
  </ol>

  <form class="card" onsubmit={next}>
    {#if step === 'language'}
      <h3>{w.language.heading}</h3>
      <p>{w.language.intro}</p>
      <label class="field">
        <span>{w.language.label}</span>
        <select
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
      </label>
    {:else if step === 'name'}
      <h3>{w.name.heading}</h3>
      <p>{w.name.intro}</p>
      <label class="field">
        <span>{w.name.ownerLabel}</span>
        <input
          type="text"
          value={draft.ownerName}
          oninput={(event) => patch({ ownerName: event.currentTarget.value })}
          autocomplete="off"
          maxlength="80"
          aria-describedby="owner-hint"
        />
        <span class="hint muted" id="owner-hint">{w.name.ownerHint}</span>
      </label>
      <label class="field">
        <span>{w.name.accountLabel}</span>
        <input
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
        <span class="hint muted" id="account-hint">{account !== null ? w.name.accountLocked : w.name.accountHint}</span>
      </label>
      {#if draft.ownerName !== '' && nameProblem !== null}
        <p class="problem" role="alert">{nameProblemText(nameProblem)}</p>
      {:else if account === null && draft.accountId !== '' && !isAccountIdValid(draft.accountId.trim())}
        <p class="problem" role="alert">{texts.errors.invalidAccountId}</p>
      {/if}
    {:else if step === 'provider'}
      <h3>{w.provider.heading}</h3>
      <p>{w.provider.intro}</p>
      <p class="muted">{w.provider.laterNote}</p>
      <fieldset class="providers">
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
                <label class="field">
                  <span>{w.provider.modelLabel}</span>
                  <input
                    type="text"
                    value={draft.claudeModel}
                    oninput={(event) => patch({ claudeModel: event.currentTarget.value })}
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="sonnet"
                  />
                </label>
              {:else}
                <label class="field">
                  <span>{w.provider.baseUrlLabel}</span>
                  <input
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
                </label>
                <label class="field">
                  <span>{w.provider.ollamaModelLabel}</span>
                  <input
                    type="text"
                    value={draft.ollamaModel}
                    oninput={(event) => patch({ ollamaModel: event.currentTarget.value })}
                    autocomplete="off"
                    spellcheck="false"
                    aria-describedby="ollama-model-hint"
                  />
                  <span class="hint muted" id="ollama-model-hint">{w.provider.ollamaModelHint}</span>
                </label>
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
                <p class="muted">{texts.ui.disclosure.test.needsConsent}</p>
              {/if}
            {/if}
          </div>
        {/each}
      </fieldset>
    {:else if step === 'transcription'}
      <h3>{w.transcription.heading}</h3>
      <p>{w.transcription.text}</p>
    {:else if step === 'link'}
      <h3>{w.link.heading}</h3>
      <p>{w.link.intro}</p>
      {#if account !== null}
        {#if linkView === 'linked'}
          <p class="note ok">{texts.ui.link.done}</p>
        {:else if linkView === 'start'}
          <div><button type="button" class="primary" onclick={startLink}>{w.link.start}</button></div>
        {:else}
          <LinkView {controller} {api} {texts} id={account} link={app.links[account]} oncancel={() => undefined} />
        {/if}
        {#if !setup.linked}
          <p class="muted">{w.link.needsLink}</p>
        {/if}
      {/if}
    {:else if step === 'schedule'}
      <h3>{w.schedule.heading}</h3>
      <p>{w.schedule.intro}</p>
      {#if schedules !== null}
        <p class="muted">{fmt(w.schedule.timezone, { timezone: schedules.timezone })}</p>
        <h4>{w.schedule.current}</h4>
        {#if schedules.schedules.length === 0}
          <p>{w.schedule.none}</p>
        {:else}
          <ul class="list">
            {#each schedules.schedules as one (one.id)}
              <li><strong>{one.time}</strong> <span>{dayLabel(one.days, texts)}</span></li>
            {/each}
          </ul>
        {/if}
      {/if}
      <div class="buttons">
        {#if schedules !== null && schedules.schedules.length === 0}
          <button type="button" class="primary" onclick={suggest} disabled={saving}>{w.schedule.suggest}</button>
        {/if}
        <button type="button" onclick={() => (showSchedules = true)}>{w.schedule.edit}</button>
      </div>
      <p class="muted">{w.schedule.skipNote}</p>
    {:else}
      <h3>{w.done.heading}</h3>
      <p>{w.done.text}</p>
      {#if schedules !== null && schedules.schedules.length === 0}
        <p class="note warn" role="status">{w.done.noSchedule}</p>
      {/if}
    {/if}

    {#if issueLines.length > 0}
      <ul class="note error issues" role="alert">
        {#each issueLines as line (line)}
          <li>{line}</li>
        {/each}
      </ul>
    {/if}
    {#if problem !== null}
      <p class="note error" role="alert">{problem}</p>
    {/if}

    <div class="buttons">
      {#if previousStep(step) !== null}
        <button type="button" onclick={back} disabled={saving}>{w.back}</button>
      {/if}
      <button type="submit" class="primary" disabled={saving || !canContinue}>
        {saving ? w.saving : step === 'done' ? w.done.finish : w.next}
      </button>
    </div>
  </form>

  <div class="skip">
    {#if confirmSkip}
      <p class="note warn" role="alert">{w.skipConfirm}</p>
      <div class="buttons">
        <button type="button" class="danger" onclick={skip} disabled={saving}>{w.skipYes}</button>
        <button type="button" onclick={() => (confirmSkip = false)}>{w.skipNo}</button>
      </div>
    {:else}
      <button type="button" class="link" onclick={() => (confirmSkip = true)}>{w.skip}</button>
    {/if}
  </div>
</section>

{#if showSchedules && accountView !== null}
  <SchedulesDialog
    {api}
    {texts}
    account={accountView}
    onclose={() => {
      showSchedules = false
      void loadSchedules()
    }}
  />
{/if}

<style>
  .wizard {
    max-width: 44rem;
    margin: 1rem auto 2rem;
    display: grid;
    gap: 1rem;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  p,
  h3,
  h4 {
    margin: 0;
  }

  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .steps li {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.2rem 0.65rem 0.2rem 0.25rem;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .steps li.current {
    border-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }

  .steps li.done {
    color: var(--ok);
  }

  .num {
    display: inline-grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: var(--neutral-bg);
    font-size: 0.8rem;
  }

  .steps li.current .num {
    background: var(--accent);
    color: var(--accent-text);
  }

  .card {
    display: grid;
    gap: 0.9rem;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    padding: 1.1rem;
  }

  .field {
    display: grid;
    gap: 0.25rem;
  }

  .field > span:first-child {
    font-weight: 600;
  }

  .hint {
    font-size: 0.85rem;
    font-weight: 400;
  }

  .providers {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }

  .choice {
    display: grid;
    gap: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
  }

  .choice.chosen {
    border-color: var(--accent);
  }

  .radio,
  .check {
    display: inline-flex;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
  }

  .radio {
    font-weight: 600;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .problem {
    color: var(--error);
    font-size: 0.9rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }

  .issues {
    padding-left: 1.75rem;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .skip {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }

  button.link {
    border: 0;
    background: none;
    padding: 0.25rem 0;
    color: var(--accent);
    text-decoration: underline;
    min-height: 0;
  }
</style>
