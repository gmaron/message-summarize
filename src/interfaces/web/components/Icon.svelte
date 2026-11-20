<script lang="ts">
  // One stroke style for every icon of the chrome. The shapes are data drawn by Svelte: no markup is ever built from text.
  type Shape =
    | { readonly t: 'path'; readonly d: string }
    | { readonly t: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
    | { readonly t: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly rx: number }

  const p = (d: string): Shape => ({ t: 'path', d })
  const ICONS: Record<string, readonly Shape[]> = {
    plus: [p('M12 5v14M5 12h14')],
    logs: [p('M5 4h14v16H5z'), p('M8 8h8M8 12h8M8 16h5')],
    home: [p('M4 11 12 4l8 7v9h-5v-6H9v6H4z')],
    alert: [{ t: 'circle', cx: 12, cy: 12, r: 9 }, p('M12 7v6M12 16.5h.01')],
    warning: [p('M12 9v4M12 17h.01'), p('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z')],
    check: [p('m5 12 4.5 4.5L19 7')],
    eye: [p('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z'), { t: 'circle', cx: 12, cy: 12, r: 3 }],
    send: [p('M4 12 20 4l-6 16-3-7z')],
    link: [p('M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z'), p('M14 14h3v3M20 14v.01M14 20h.01M17 17h4v4')],
    back: [p('m14 6-6 6 6 6')],
    lock: [{ t: 'rect', x: 5, y: 11, w: 14, h: 9, rx: 2 }, p('M8 11V8a4 4 0 0 1 8 0v3')],
    trash: [p('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3')],
    search: [{ t: 'circle', cx: 11, cy: 11, r: 6 }, p('m20 20-4.5-4.5')],
  }

  let { name, size = 18 }: { name: string; size?: number } = $props()
  const shapes = $derived(ICONS[name] ?? [])
</script>

<svg class="i" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
  {#each shapes as shape, index (index)}
    {#if shape.t === 'path'}
      <path d={shape.d} />
    {:else if shape.t === 'circle'}
      <circle cx={shape.cx} cy={shape.cy} r={shape.r} />
    {:else}
      <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.rx} />
    {/if}
  {/each}
</svg>

<style>
  .i {
    flex: none;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
