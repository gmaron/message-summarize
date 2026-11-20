<script lang="ts">
  import { untrack } from 'svelte'
  import { SETUP_STEPS_SHOWN } from '../../../domain/setup.js'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { accountIdFrom, badgeOf } from '../lib/accounts.js'
  import { displayHostOf, isApiProvider, isOpenAiUrl } from '../lib/api-providers.js'
  import { type Api, ApiError } from '../lib/api.js'
  import type { Controller } from '../lib/controller.js'
  import { errorText } from '../lib/digest.js'
  import { isUtcZone } from '../lib/format.js'
  import { browserTimeZone, fmt } from '../lib/i18n.js'
  import { issueReason, issuesOf, optionLabel } from '../lib/settings.js'
  import {
    ollamaUrlOf,
    emptyDraft,
    consentKeyOf,
    hostOf,
    openaiAddressInvalid,
    openaiUrlOf,
    shownOriginOf,
    recipientOf,
    recipientOfDraft,
    withOpenAiBaseUrl,
    nameBody,
    nameIssue,
    previousStep,
    providerBody,
    providerIssue,
    stepIndicator,
    testBody,
    withBaseUrl,
    WIZARD_PROVIDERS,
    type WizardDraft,
  } from '../lib/setup.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, SetupStep, SetupView } from '../lib/types.js'
  import ApiKeyField from './ApiKeyField.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import Disclosure from './Disclosure.svelte'
  import Icon from './Icon.svelte'
  import LanguageSwitch from './LanguageSwitch.svelte'
  import LinkStart from './LinkStart.svelte'
  import LinkView from './LinkView.svelte'
  import ProviderTest from './ProviderTest.svelte'

  let {
    controller,
    api,
    texts,
    app,
    setup,
  }: { controller: Controller; api: Api; texts: WebTexts; app: AppState; setup: SetupView } = $props()

  const w = $derived(texts.ui.wizard)
  const step: SetupStep = $derived(setup.step)
  const total = SETUP_STEPS_SHOWN.length
  const account = $derived(setup.account)
  const accountView: AccountView | null = $derived(
    account === null ? null : (app.accounts?.find((row) => row.id === account) ?? null),
  )

  // What the user typed. It is restored from the daemon when the wizard is reopened (the account's own settings).
  let draft: WizardDraft = $state.raw(untrack(() => emptyDraft(setup.language)))
  let saving = $state(false)
  let problem: string | null = $state(null)
  let issueLines: string[] = $state.raw([])
  let confirmSkip = $state(false)
  /** The addresses the account has saved: an agreement already recorded covers only those, not what is typed now. */
  let saved: { ollama: string; openai: string } | null = $state.raw(null)
  const patch = (change: Partial<WizardDraft>): void => {
    draft = { ...draft, ...change }
    problem = null
    issueLines = []
  }

  // The account name is checked once the user leaves the field (not while they are still typing the other one).
  let accountTouched = $state(false)
  // Changes when a key is saved or removed: the list of models of the provider is asked again.
  let keyVersion = $state(0)
  // The time zone the digests follow (read from the system by the daemon; shown, never asked).
  let zone: string | null = $state(null)
  $effect(() => {
    if (step !== 'done' || account === null) return
    const id = account
    untrack(async () => {
      try {
        zone = (await api.schedules(id)).timezone
      } catch {
        zone = null
      }
    })
  })

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
        const openaiUrl = view.values.provider.openai.baseUrl
        saved = { ollama: view.values.provider.ollama.baseUrl, openai: openaiUrl }
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
                // OpenAI's own address is the default: the field stays empty unless a server of the user's is in force.
                openaiBaseUrl: isOpenAiUrl(openaiUrl) ? '' : openaiUrl,
                openaiModel: view.values.provider.openai.model ?? '',
                anthropicModel: view.values.provider.anthropic.model ?? '',
                geminiModel: view.values.provider.gemini.model ?? '',
              }),
        })
      } catch {
        // The form stays as it is: the user can fill it in again.
      }
    })
  })
  // The address Ollama has when its field is empty, as the daemon says it (it may not be on this machine).
  $effect(() => {
    const inherited = setup.ollamaBaseUrl
    if (inherited !== draft.ollamaInherited) untrack(() => patch({ ollamaInherited: inherited }))
  })
  // The address OpenAI has in the configuration: what an empty field means.
  $effect(() => {
    const inherited = setup.openaiBaseUrl
    if (inherited !== draft.openaiInherited) untrack(() => patch({ openaiInherited: inherited }))
  })
  // The agreement already recorded for this account is shown as given, but only for the recipient it was given for: another
  // address (a compatible server, a remote Ollama) is another recipient and asks again.
  $effect(() => {
    const key = consentKeyOf(draft)
    const recipient = recipientOfDraft(draft)
    const given =
      key !== null &&
      setup.consents.includes(key) &&
      saved !== null &&
      recipient === recipientOf(draft.provider, saved.ollama, saved.openai)
    if (given && !draft.consent) untrack(() => patch({ consent: true }))
  })

  const nameProblem = $derived(nameIssue(draft, account !== null))
  /** What the account is called: what was typed, turned into an id (shown live, and what is sent). */
  const accountId = $derived(accountIdFrom(draft.accountId))
  /** An account of that name already exists and is not linked: the wizard takes it (it is not an error). */
  const adopting = $derived(
    account === null && accountId !== '' && (app.accounts ?? []).some((row) => row.id === accountId && badgeOf(row) === 'notLinked'),
  )
  const previewText = $derived(
    account !== null || accountId === ''
      ? ''
      : fmt(adopting ? texts.ui.addAccount.idPreviewExisting : texts.ui.addAccount.idPreview, { id: accountId }),
  )
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
    } else if (error?.code === 'consentRequired') {
      // The daemon decides who the recipient is. If it is not the one on screen, the agreement given does not stand: the box
      // is cleared and the page says so (the setup is asked again, so the notice shows what the daemon has).
      const shown = consentKeyOf(draft)
      const previous = draft
      draft = { ...draft, consent: false }
      const origin = error.origin
      const other =
        error.provider !== undefined &&
        (error.provider !== shown || (origin !== undefined && origin !== shownOriginOf(previous)))
      problem = other
        ? fmt(texts.ui.disclosure.consentChanged, {
            provider: (origin !== undefined ? displayHostOf(origin) : null) ?? consentName(error.provider ?? ''),
          })
        : texts.ui.disclosure.consentNeeded
      void controller.loadSetup()
    } else problem = errorText(error?.code ?? 'internal', texts)
    return false
  }

  async function next(event?: SubmitEvent) {
    event?.preventDefault()
    if (saving) return
    switch (step) {
      case 'you':
        if (nameProblem === null) await send(nameBody({ ...draft, language: app.language }, account !== null, browserTimeZone()))
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
    code === 'invalidAccountId' ? texts.errors.invalidAccountId : texts.ui.wizard.you[code]
  const consentName = (key: string): string => {
    const names = texts.ui.disclosure.providers as Record<string, { name: string }>
    return names[key === 'ollama-remote' ? 'ollama' : key]?.name ?? key
  }
  const providerName = (name: string): string =>
    (texts.ui.disclosure.providers as Record<string, { name: string }>)[name]?.name ?? name
  const consentKey = $derived(consentKeyOf(draft))
  /** An address that is not a web address names no recipient: no notice is shown for it and nothing can be sent. */
  const openaiInvalid = $derived(draft.provider === 'openai' && openaiAddressInvalid(draft))
  const openaiCompatible = $derived(draft.provider === 'openai' && !openaiInvalid && !isOpenAiUrl(openaiUrlOf(draft)))
  /** The host of the server that gets the text when it is not a fixed provider (a remote Ollama, a compatible server), or null. */
  const remoteHost = $derived(
    consentKey === 'ollama-remote'
      ? hostOf(ollamaUrlOf(draft))
      : openaiCompatible
        ? displayHostOf(openaiUrlOf(draft))
        : null,
  )
  const modelField = { openai: 'openaiModel', anthropic: 'anthropicModel', gemini: 'geminiModel' } as const
  const canContinue = $derived(
    step === 'link' ? setup.linked && !linkBusy : step === 'you' ? nameProblem === null : step === 'provider' ? providerProblem === null : true,
  )
</script>

{#snippet consentBox()}
  {#if consentKey !== null && !openaiInvalid}
    <label class="check">
      <input
        type="checkbox"
        checked={draft.consent}
        onchange={(event) => patch({ consent: event.currentTarget.checked })}
      />
      <span>{fmt(texts.ui.disclosure.consentCheckbox, { provider: remoteHost ?? providerName(draft.provider) })}</span>
    </label>
  {/if}
{/snippet}

<div class="wizard-page">
  <div class="head">
    <h1>{w.title}</h1>
    <div class="r">
      {#if step !== 'done'}<span class="muted small">{fmt(w.stepOf, { n: Math.min(SETUP_STEPS_SHOWN.indexOf(step) + 1, total), total })}</span>{/if}
      {#if setup.freshInstall}
        <LanguageSwitch {texts} current={app.language} onchoose={(language) => controller.setLanguage(language)} />
      {/if}
    </div>
  </div>

  <ol class="stepper" aria-label={w.stepsLabel}>
    {#each stepIndicator(step) as item (item.step)}
      <li class:done={item.state === 'done'} aria-current={item.state === 'current' ? 'step' : undefined}>
        <span class="n">{#if item.state === 'done'}<Icon name="check" size={14} />{:else}{item.number}{/if}</span>{w.steps[item.step]}
      </li>
    {/each}
  </ol>

  <form class="form-section" onsubmit={next}>
    {#if step === 'you'}
      <h2>{w.you.heading}</h2>
      <p>{w.you.intro}</p>
      <div class="field">
        <label for="wizard-owner">{w.you.ownerLabel}</label>
        <input
          id="wizard-owner"
          type="text"
          value={draft.ownerName}
          oninput={(event) => patch({ ownerName: event.currentTarget.value })}
          autocomplete="off"
          maxlength="80"
          aria-describedby="owner-hint"
        />
        <span class="hint" id="owner-hint">{w.you.ownerHint}</span>
      </div>
      <div class="field">
        <label for="wizard-account">{w.you.accountLabel}</label>
        <input
          id="wizard-account"
          type="text"
          value={draft.accountId}
          oninput={(event) => patch({ accountId: event.currentTarget.value })}
          onblur={() => (accountTouched = true)}
          disabled={account !== null}
          required
          placeholder={texts.ui.addAccount.idPlaceholder}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="64"
          aria-describedby="account-hint account-preview"
        />
        <span class="hint" id="account-hint">{account !== null ? w.you.accountLocked : w.you.accountHint}</span>
        <!-- Always there (only its text changes) so it is announced and the description always points at something. -->
        <span class="hint strong" id="account-preview" aria-live="polite">{previewText}</span>
      </div>
      {#if nameProblem === 'ownerTooLong'}
        <p class="err small bad-text" role="alert">{nameProblemText(nameProblem)}</p>
      {:else if account === null && accountTouched && accountId === ''}
        <p class="err small bad-text" role="alert">{texts.ui.addAccount.idNothing}</p>
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
              {#if provider === 'openai' && openaiInvalid}
                <p class="muted small">{w.provider.openaiBaseUrlInvalid}</p>
              {:else}
                <Disclosure {texts} {provider} host={remoteHost ?? undefined} compatible={openaiCompatible} />
              {/if}
              {#if provider === 'claude-cli'}
                {#if account !== null}
                  <ModelPicker
                    {api}
                    {texts}
                    {account}
                    provider="claude-cli"
                    id="wizard-claude-model"
                    label={w.provider.modelLabel}
                    value={draft.claudeModel}
                    onchange={(model) => patch({ claudeModel: model })}
                  />
                {/if}
              {:else if isApiProvider(provider)}
                {#if provider === 'openai'}
                  <div class="field">
                    <label for="wizard-openai-url">{w.provider.openaiBaseUrlLabel}</label>
                    <input
                      id="wizard-openai-url"
                      type="text"
                      value={draft.openaiBaseUrl}
                      oninput={(event) => {
                        draft = withOpenAiBaseUrl(draft, event.currentTarget.value)
                        problem = null
                        issueLines = []
                      }}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck="false"
                      placeholder="https://api.openai.com/v1"
                      aria-describedby="wizard-openai-url-hint"
                    />
                    <span class="hint" id="wizard-openai-url-hint">{w.provider.openaiBaseUrlHint}</span>
                  </div>
                {/if}
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
                {#if account !== null}
                  <ModelPicker
                    {api}
                    {texts}
                    {account}
                    provider="ollama"
                    id="wizard-ollama-model"
                    label={w.provider.ollamaModelLabel}
                    hint={w.provider.ollamaModelHint}
                    value={draft.ollamaModel}
                    onchange={(model) => patch({ ollamaModel: model })}
                    baseUrl={ollamaUrlOf(draft)}
                    consent={consentKey === 'ollama-remote' && draft.consent ? 'ollama-remote' : undefined}
                  />
                {/if}
              {/if}
              {#if isApiProvider(provider) && account !== null}
                <ApiKeyField
                  {api}
                  {texts}
                  {account}
                  {provider}
                  baseUrl={provider === 'openai' ? openaiUrlOf(draft) : ''}
                  idSuffix="wizard-{provider}"
                  lockedNote={provider === 'openai' && openaiInvalid ? w.provider.openaiBaseUrlInvalid : undefined}
                  test={{ body: testBody(draft), blocked: providerProblem !== null }}
                  beforeTest={consentBox}
                  onkeychange={() => (keyVersion += 1)}
                >
                  {#snippet afterKey()}
                    <ModelPicker
                      {api}
                      {texts}
                      {account}
                      {provider}
                      id="wizard-{provider}-model"
                      label={w.provider.apiModelLabel}
                      hint={w.provider.apiModelHint}
                      value={draft[modelField[provider]]}
                      onchange={(model) => patch({ [modelField[provider]]: model })}
                      reload={keyVersion}
                      typingOnly={provider === 'openai' && openaiCompatible}
                    />
                  {/snippet}
                </ApiKeyField>
              {:else}
                {@render consentBox()}
                <ProviderTest {api} {texts} body={testBody(draft)} blocked={providerProblem !== null} />
              {/if}
              {#if providerProblem === 'consent'}
                <p class="muted small">{texts.ui.disclosure.test.needsConsent}</p>
              {/if}
            {/if}
          </div>
        {/each}
      </fieldset>
    {:else if step === 'link'}
      <h2>{w.link.heading}</h2>
      <p>{w.link.intro}</p>
      {#if account !== null}
        {#if linkView === 'linked'}
          <p class="notice ok">{texts.ui.link.done}</p>
        {:else if linkView === 'start'}
          <LinkStart {texts} onstart={startLink} idSuffix="wizard" />
        {:else}
          <LinkView {controller} {api} {texts} id={account} link={app.links[account]} oncancel={() => undefined} />
        {/if}
        {#if !setup.linked}
          <p class="muted small">{w.link.needsLink}</p>
        {/if}
      {/if}
    {:else}
      <h2>{w.done.heading}</h2>
      <p>{w.done.text}</p>
      <p class="muted small">{w.done.schedules}</p>
      {#if zone !== null}
        <p class="muted small">
          {fmt(texts.ui.schedules.zoneLine, { zone })}{#if isUtcZone(zone)} {texts.ui.schedules.zoneUtcHint}{/if}
        </p>
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
