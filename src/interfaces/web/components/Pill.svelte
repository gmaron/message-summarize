<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { type AccountView } from '../lib/types.js'
  import { pillOf, pillText } from '../lib/accounts.js'

  // The state of an account in one word, with the colour that says whether it needs its owner.
  let { account, texts, running = false }: { account: AccountView; texts: WebTexts; running?: boolean } = $props()
  const pill = $derived(pillOf(account, running))
</script>

<span class="pill {pill.tone}">{pillText(pill.key, texts)}</span>
