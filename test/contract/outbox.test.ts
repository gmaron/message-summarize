import { describeOutboxContract, outboxBackends } from './outbox.contract.js'

for (const backend of outboxBackends) describeOutboxContract(backend)
