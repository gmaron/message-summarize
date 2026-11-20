<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { fmt } from '../lib/i18n.js'
  import type { ProviderName } from '../lib/types.js'

  // What a provider costs and does with the text of the chats (RF-41, RNF-02). Fixed texts of the page: nothing here comes
  // from the daemon or from a chat.
  // `host`: the Ollama server is not on this machine, so the text goes there (the remote variant, with the host named).
  // `compatible`: OpenAI pointed at another server (`host` is that server): external even when it is on this machine.
  let {
    texts,
    provider,
    host,
    compatible = false,
  }: { texts: WebTexts; provider: ProviderName; host?: string; compatible?: boolean } = $props()

  const d = $derived(texts.ui.disclosure)
  const remote = $derived(provider === 'ollama' && host !== undefined)
  const api = $derived(provider === 'openai' || provider === 'anthropic' || provider === 'gemini')
  const info = $derived.by(() => {
    if (provider === 'openai' && compatible) {
      const c = d.providers['openai-compatible']
      return { ...c, leaves: fmt(c.leaves, { host: host ?? '' }), who: fmt(c.who, { host: host ?? '' }) }
    }
    const base = d.providers[provider]
    if (!remote) return base
    const r = d.ollamaRemote
    return {
      ...base,
      cost: r.cost,
      leaves: fmt(r.leaves, { host: host ?? '' }),
      who: fmt(r.who, { host: host ?? '' }),
      what: r.what,
    }
  })
</script>

<dl class="disclosure">
  <dt>{d.sendsLabel}</dt>
  <dd>{d.sends}</dd>
  <dt>{d.costLabel}</dt>
  <dd>{info.cost}</dd>
  <dt>{d.leavesLabel}</dt>
  <dd>{info.leaves}</dd>
  <dt>{d.whoLabel}</dt>
  <dd>{info.who}</dd>
  <dt>{d.whatLabel}</dt>
  <dd>{info.what}</dd>
</dl>
{#if info.tools !== undefined}
  <p class="notice info small">{info.tools}</p>
{/if}
{#if info.warning !== undefined}
  <p class="notice warn small">{info.warning}</p>
{/if}
{#if api}
  <p class="notice warn small">{d.apiLocalOnly}</p>
{/if}
{#if remote}
  <p class="notice warn small">{d.ollamaRemote.localOnly}</p>
{/if}
