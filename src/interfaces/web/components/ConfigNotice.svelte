<script lang="ts">
  import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
  import { hrefOf } from '../lib/router.js'
  import type { AccountView } from '../lib/types.js'
  import Icon from './Icon.svelte'

  // Said instead of a section that cannot work while the configuration of the account is not valid.
  let { texts, account }: { texts: WebTexts; account: AccountView } = $props()
</script>

<div class="notice bad" role="alert">
  <div class="row">
    <Icon name="alert" />
    <div class="stack-sm">
      <b>{texts.ui.account.configProblem}</b>
      <span>{texts.ui.account.configProblemText}</span>
    </div>
  </div>
  <div class="acts">
    <a class="btn" href={hrefOf({ name: 'account', id: account.id, tab: 'ajustes' })}>{texts.ui.account.fixSettings}</a>
  </div>
</div>
