import { backends } from '../support/persistence-backends.js'
import { describeDigestSourceContract } from './digest-source.contract.js'

for (const backend of backends) describeDigestSourceContract(backend)
