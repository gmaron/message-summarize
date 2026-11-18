import { backends } from '../support/persistence-backends.js'
import { describeDigestStoreContract } from './digest-store.contract.js'

for (const backend of backends) describeDigestStoreContract(backend)
