import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { createApi, type FetchFn } from './lib/api.js'
import { consumeToken } from './lib/auth.js'
import { createController } from './lib/controller.js'
import { textsFor } from './lib/i18n.js'

const request: FetchFn = (input, init) => fetch(input, init)

const controller = createController({
  api: createApi(request, () => controller.markUnauthorized()),
  createEventSource: () => new EventSource('/api/events'),
  browserLanguage: navigator.language,
  browserLanguages: navigator.languages,
})

document.title = textsFor(controller.state.language).ui.title
mount(App, { target: document.getElementById('app') as HTMLElement, props: { controller, api: controller.api } })

// The token of the address is exchanged for the session first; only then is anything asked of the daemon.
const auth = await consumeToken({ location, history, fetch: request })
if (auth === 'rejected') controller.markUnauthorized()
else await controller.start()
