import { backends } from '../support/persistence-backends.js'
import { describeTranscriptionStoreContract } from './transcription-store.contract.js'

for (const backend of backends) describeTranscriptionStoreContract(backend)
