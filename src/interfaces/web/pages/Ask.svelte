<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import AccountHeader from '../components/AccountHeader.svelte'
  import Icon from '../components/Icon.svelte'
  import { accountActions } from '../lib/accounts.js'
  import { type Api, ApiError } from '../lib/api.js'
  import { errorText } from '../lib/digest.js'
  import { formatDateTime } from '../lib/format.js'
  import { fmt } from '../lib/i18n.js'
  import type { AppState } from '../lib/state.js'
  import type { AccountView, AskView } from '../lib/types.js'

  // Pedir: a free request over the chats of a period, typed or dictated. The answers are private text: they come from
  // the daemon on request, are drawn as text only (never as markup) and live in its memory, not in this page.
  let { api, texts, account, now }: { app: AppState; api: Api; texts: WebTexts; account: AccountView; now: number } =
    $props()
  const t = $derived(texts.ui.ask)
  const id = $derived(account.id)
  const usable = $derived(accountActions(account).digest)

  type Period = AskView['period']
  const periods: readonly Period[] = ['today', 'h24', 'd3', 'd7']

  let question = $state('')
  let period: Period = $state('today')
  let chats = $state('')
  let submitting = $state(false)
  let error: string | null = $state(null)
  let asks: readonly AskView[] = $state.raw([])
  let copied = $state(-1)

  const running = $derived(submitting || asks.some((a) => a.state === 'running'))

  async function load(): Promise<void> {
    try {
      asks = await api.asks(untrack(() => id))
    } catch {
      // The list is an extra: the form keeps working.
    }
  }

  // Loaded once, and followed every 2 seconds only while a request is running.
  $effect(() => {
    void id
    void load()
  })
  $effect(() => {
    if (!running) return
    const timer = setInterval(() => void load(), 2000)
    return () => clearInterval(timer)
  })

  async function submit(): Promise<void> {
    if (question.trim() === '' || running) return
    error = null
    submitting = true
    try {
      await api.ask(id, {
        question,
        period,
        chats: chats
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c !== ''),
      })
      question = ''
      await load()
    } catch (e) {
      error = errorText(e instanceof ApiError ? e.code : null, texts)
    } finally {
      submitting = false
    }
  }

  async function remove(askId: number): Promise<void> {
    try {
      await api.deleteAsk(id, askId)
    } catch {
      // already gone
    }
    await load()
  }

  const plain = (ask: AskView): string =>
    [ask.question, ...(ask.items ?? []).map((i) => `\n*${i.name}*\n${i.answer}${i.todos.map((x) => `\n☐ ${x}`).join('')}`)].join('\n')

  async function copy(ask: AskView): Promise<void> {
    try {
      await navigator.clipboard.writeText(plain(ask))
      copied = ask.id
    } catch {
      copied = -1
    }
  }

  const statsOf = (ask: AskView): string => {
    const consulted = ask.consulted ?? 0
    const answered = ask.items?.length ?? 0
    const failed = ask.failedChats ?? 0
    const plural = (count: number, one: string, many: string): string => (count === 1 ? one : fmt(many, { count }))
    const values = {
      read: plural(consulted, t.statsReadOne, t.statsReadMany),
      answered: plural(answered, t.statsAnsweredOne, t.statsAnsweredMany),
      failed: plural(failed, t.statsFailedOne, t.statsFailedMany),
    }
    return fmt(failed > 0 ? t.statsFailed : t.stats, values)
  }
  const failedText = (ask: AskView): string => errorText(ask.error === 'failed' ? null : ask.error, texts)

  // Dictation: the speech recognition of the browser, when it has one. It only fills the box: the user reads it first.
  type Recognition = {
    lang: string
    interimResults: boolean
    continuous: boolean
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
    onerror: ((event: { error: string }) => void) | null
    onend: (() => void) | null
    start(): void
    stop(): void
  }
  const Speech = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
  const SpeechApi = Speech.SpeechRecognition ?? Speech.webkitSpeechRecognition
  let listening = $state(false)
  let micNote: string | null = $state(null)
  let recognition: Recognition | null = null
  let base = ''

  function toggleMic(): void {
    if (SpeechApi === undefined) {
      micNote = t.micUnsupported
      return
    }
    if (listening) {
      recognition?.stop()
      return
    }
    micNote = null
    const r = new SpeechApi()
    r.lang = texts.locale
    r.interimResults = true
    r.continuous = false
    base = question.trim() === '' ? '' : `${question.trim()} `
    r.onresult = (event) => {
      let text = ''
      for (let i = 0; i < event.results.length; i++) text += event.results[i]?.[0]?.transcript ?? ''
      question = base + text
    }
    r.onerror = (event) => {
      micNote = t.micUnsupported
    }
    r.onend = () => {
      listening = false
    }
    recognition = r
    listening = true
    try {
      r.start()
    } catch {
      listening = false
    }
  }
  onDestroy(() => recognition?.stop())

  function shortcut(text: string): void {
    question = text
  }
</script>

<div class="page-inner">
  <AccountHeader {account} {texts} tab="pedir" />

  <div class="stack">
    {#if !usable}<div class="notice warn measure" role="status">{t.notRunning}</div>{/if}

    <form class="panel stack measure" onsubmit={(e) => { e.preventDefault(); void submit() }}>
      <div class="field">
        <label for="ask-q">{t.questionLabel}</label>
        <textarea id="ask-q" rows="4" maxlength="1000" placeholder={t.placeholder} bind:value={question} disabled={!usable}></textarea>
        <div class="cluster">
          <button type="button" class="btn sm" aria-pressed={listening} onclick={toggleMic} disabled={!usable}>
            <Icon name="mic" />{t.mic}
          </button>
          {#if listening}<span class="small muted" role="status">{t.micListening}</span>{/if}
        </div>
        {#if micNote !== null}<span class="err" role="alert">{micNote}</span>{/if}
        <span class="hint">{t.micNote}</span>
      </div>

      <div class="field">
        <span class="lab">{t.shortcutsLabel}</span>
        <div class="chips">
          {#each t.shortcuts as item (item.label)}
            <button type="button" class="chip" onclick={() => shortcut(item.question)}>{item.label}</button>
          {/each}
        </div>
      </div>

      <div class="field">
        <span class="lab" id="ask-period">{t.periodLabel}</span>
        <div class="chips" role="group" aria-labelledby="ask-period">
          {#each periods as p (p)}
            <button type="button" class="chip" aria-pressed={period === p} onclick={() => (period = p)}>{t.periods[p]}</button>
          {/each}
        </div>
      </div>

      <div class="field">
        <label for="ask-chats">{t.chatsLabel}</label>
        <input id="ask-chats" type="text" placeholder={t.chatsPlaceholder} bind:value={chats} disabled={!usable} />
      </div>

      {#if error !== null}<div class="notice bad" role="alert">{error}</div>{/if}
      <div class="cluster">
        <button type="submit" class="btn primary" disabled={!usable || running || question.trim() === ''}>
          <Icon name="send" />{t.submit}
        </button>
      </div>
    </form>

    <div class="sr" role="status" aria-live="polite">{running ? t.running : ''}</div>

    <h2>{t.historyTitle}</h2>
    {#each asks as ask (ask.id)}
      <article class="panel stack measure">
        <p class="break"><strong>{ask.question}</strong></p>
        <p class="small muted">
          {t.periods[ask.period]}{texts.ui.text.separator}{formatDateTime(ask.createdAt, account.timezone, texts.locale)}
          {#if ask.chats.length > 0}{texts.ui.text.separator}{ask.chats.join(', ')}{/if}
        </p>
        {#if ask.state === 'running'}
          <div class="progress"><progress class="bar" aria-label={t.running}></progress></div>
          <p class="small muted">{t.running}</p>
        {:else if ask.state === 'failed'}
          <div class="notice bad" role="alert">{failedText(ask)}</div>
        {:else}
          <p class="small muted">{statsOf(ask)}</p>
          {#if (ask.items ?? []).length === 0}
            <p>{t.nothing}</p>
          {/if}
          {#each ask.items ?? [] as item, index (index)}
            <div class="stack-sm">
              <p class="break"><strong>{item.name}</strong>{#if item.needsReply}{' '}<span class="small muted">· {t.needsReply}</span>{/if}</p>
              <p class="answer break">{item.answer}</p>
              {#if item.todos.length > 0}
                <ul class="small">
                  {#each item.todos as todo, i (i)}<li>{todo}</li>{/each}
                </ul>
              {/if}
            </div>
          {/each}
        {/if}
        <div class="cluster">
          {#if ask.state === 'done' && (ask.items ?? []).length > 0}
            <button type="button" class="btn sm" onclick={() => copy(ask)}>{copied === ask.id ? t.copied : t.copy}</button>
          {/if}
          {#if ask.state !== 'running'}
            <button type="button" class="btn sm quiet" onclick={() => remove(ask.id)}><Icon name="trash" />{t.remove}</button>
          {/if}
        </div>
      </article>
    {/each}
    <p class="small muted measure">{t.privateNote}</p>
  </div>
</div>

<style>
  .answer {
    white-space: pre-wrap;
    margin: 0;
  }
</style>
