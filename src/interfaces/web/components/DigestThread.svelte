<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { type Line, parseDigest, type Span } from '../lib/digest-text.js'
  import { fmt } from '../lib/i18n.js'

  // The digest as it lands in the chat: a day chip and one bubble per message part. The text of a digest is written from
  // chats of third parties: it is cut into lines and *bold* spans (`parseDigest`) and every span is drawn as a text
  // node, never as markup.
  let {
    texts,
    parts,
    day,
    time,
    status,
    fresh = false,
    skeleton = false,
  }: {
    texts: WebTexts
    /** The text of each message part, as sent. */
    parts: readonly string[]
    /** The chip over the first bubble (Today, Yesterday, a date); empty for none. */
    day: string
    time: string
    /**
     * sent: two sea-green ticks, only for a digest the daemon said it delivered in this session. generated: one grey tick,
     * a digest read from the history (it was made; the page cannot say that it arrived). queued: one grey tick, waiting
     * for the account. pending: a clock. draft: a clock, not sent.
     */
    status: 'sent' | 'generated' | 'queued' | 'pending' | 'draft'
    /** The bubble arrives with a small motion (a digest that has just been delivered). */
    fresh?: boolean
    /** Lines of skeleton instead of text: the digest is being made. */
    skeleton?: boolean
  } = $props()

  const t = $derived(texts.ui.bubble)
  const bubbles = $derived(skeleton ? [''] : parts)
  const tickLabel = $derived(
    status === 'sent' ? t.sent : status === 'queued' ? t.queued : status === 'generated' ? t.generated : t.pending,
  )
  const label = (index: number): string =>
    skeleton ? t.preparing : bubbles.length > 1 ? fmt(t.part, { n: index + 1, total: bubbles.length }) : t.digest
</script>

{#snippet spans(list: readonly Span[])}{#each list as span, index (index)}{#if span.bold}<b>{span.text}</b>{:else}{span.text}{/if}{/each}{/snippet}

<!-- The emoji that opens a section head gets a gap of its own; it is still the text of the digest. -->
{#snippet headSpans(list: readonly Span[])}
  {@const first = list[0]}
  {@const lead = first === undefined ? null : /^(\p{Extended_Pictographic}\uFE0F?)\s*([\s\S]*)$/u.exec(first.text)}
  {#if lead !== null && first !== undefined}
    <span class="emoji">{lead[1]}</span>{#if first.bold}<b>{lead[2]}</b>{:else}{lead[2]}{/if}{@render spans(list.slice(1))}
  {:else}
    {@render spans(list)}
  {/if}
{/snippet}

{#snippet row(line: Line)}
  {#if line.kind === 'title'}
    <div class="ttl">{@render spans(line.spans)}</div>
  {:else if line.kind === 'heading'}
    <div class="sechead">{@render headSpans(line.spans)}</div>
  {:else if line.kind === 'item'}
    <div class="it">
      <span>{@render spans(line.spans)}</span>
      {#each line.tasks as task, index (index)}
        <span class="task">{@render spans(task)}</span>
      {/each}
    </div>
  {:else if line.kind === 'task'}
    <span class="task">{@render spans(line.spans)}</span>
  {:else}
    <div class="text">{@render spans(line.spans)}</div>
  {/if}
{/snippet}

<div class="thread">
  {#if day !== ''}<span class="day-chip">{day}</span>{/if}
  {#each bubbles as part, index (index)}
    <article class="bubble" class:cont={index > 0} class:draft={status === 'draft'} class:fresh aria-label={label(index)}>
      {#if skeleton}
        <div class="lines">
          <div class="skeleton w-70"></div>
          <div class="skeleton w-92"></div>
          <div class="skeleton w-55"></div>
        </div>
      {:else}
        {#each parseDigest(part, index === 0) as block, blockIndex (blockIndex)}
          <div class="sec" class:top={blockIndex === 0 && block[0]?.kind === 'title'}>
            {#each block as line, lineIndex (lineIndex)}
              {@render row(line)}
            {/each}
          </div>
        {/each}
      {/if}
      <div class="foot">
        <span class="num">{time}</span>
        {#if status === 'draft'}<span>{t.draft}</span>{/if}
        {#if status === 'queued'}<span>{t.queued}</span>{/if}
        {#if status === 'generated'}<span>{t.generated}</span>{/if}
        <span class="ticks" class:done={status === 'sent'} role="img" aria-label={status === 'draft' ? t.draft : tickLabel}>
          {#if status === 'sent'}
            <svg viewBox="0 0 18 14"><path d="m1 7.5 3.5 3.5L11 4" /><path d="m8.5 10.5.5.5L15.5 4" /></svg>
          {:else if status === 'queued' || status === 'generated'}
            <svg viewBox="0 0 18 14"><path d="m2 7.5 3.5 3.5L12 4" /></svg>
          {:else}
            <svg viewBox="0 0 18 14"><circle cx="9" cy="7" r="5.2" /><path d="M9 4.4V7l1.8 1.2" /></svg>
          {/if}
        </span>
      </div>
    </article>
  {/each}
</div>

<style>
  .thread {
    display: grid;
    gap: 6px;
    justify-items: start;
  }

  .day-chip {
    justify-self: center;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--ink-2);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 3px 10px;
    margin-bottom: 6px;
  }

  .bubble {
    background: var(--bubble);
    border-radius: 16px;
    padding: 20px 22px 12px;
    max-width: 680px;
    width: 100%;
    display: grid;
    gap: 14px;
    line-height: 1.55;
    position: relative;
    overflow-wrap: anywhere;
  }

  .bubble.draft {
    background: color-mix(in srgb, var(--bubble) 70%, var(--ground));
  }

  .bubble.fresh {
    animation: arrive 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  @keyframes arrive {
    from {
      transform: translateY(10px);
      opacity: 0.4;
    }
    to {
      transform: none;
      opacity: 1;
    }
  }

  .sec {
    display: grid;
    gap: 8px;
  }

  .sec.top {
    gap: 4px;
  }

  .ttl,
  .sechead {
    font-weight: 700;
  }

  .sec.top .text {
    color: var(--ink-2);
  }

  .it {
    display: grid;
    gap: 2px;
  }

  .task {
    padding-left: 1.4em;
    color: var(--ink-2);
  }

  .lines {
    display: grid;
    gap: 8px;
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    align-items: center;
    font-size: 0.75rem;
    color: var(--mute);
    text-align: right;
  }

  .emoji {
    margin-right: 0.5em;
  }

  .ticks {
    display: inline-flex;
    color: var(--mute);
    transition: color 0.25s ease-out;
  }

  .ticks.done {
    color: var(--ok);
  }

  .ticks svg {
    width: 18px;
    height: 14px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  @media (max-width: 760px) {
    .bubble {
      padding: 16px 16px 10px;
    }
  }
</style>
