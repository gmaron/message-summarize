# Evaluation set for the local Ollama model (RF-45)

81 made-up conversations taken from the golden files, used by `npm run eval:ollama` (see the main README, "Choosing a
local model"). No real data.

- `transcripts.json`: the exact text the summarizer receives, produced by `node test/eval/extract-cases.mjs`.
- `labels.json`: the reference label of each case, written by hand, with a one-line reason.
- `results/`: the output of the evaluation. **It is not ignored by git on purpose.** A results file that is committed
  (together with the matching `evaluated: true` entry in `src/infrastructure/llm/ollama-candidates.ts`) is what
  promotes a candidate to "evaluated"; a test fails if a committed passing result is not reflected in the table.

## Labelling rule

`needsReply` is whether the owner still has to answer something. Read only the visible text; never assume a reply
that is not in it.

**true** when the last relevant message to the owner still expects something from the owner:

- a question addressed to the owner that is unanswered in the visible text, or
- a request that is answered in the chat (information, a confirmation, a file, a call back), or
- an explicit ask to be told back ("avisame", "contame", "confirmame").

**false** when:

- the contact only closes or acknowledges ("perfecto", "genial, gracias", "quedo atento"), even if the owner promised
  an action earlier: a pending action of the owner's is a pending item (`pendientes`), not a needed reply;
- the message is information, a notice or a reminder to do something outside the chat (sign, pay, pick up);
- a question is open to a whole group and not addressed to the owner.

Written down after the first labelling pass; every label was re-checked against it. Cases where a reader could still
argue are marked `"doubtful": true`.

## Scoring

- `"jsonOnly": true` marks filler with no real message (the truncation scenario, c31 to c36). They count for the
  valid-JSON check and not for agreement.
- **Valid JSON** is judged over every case and must be 100%.
- **Agreement** (the 90% of RF-45) is judged on the **clear** cases: not doubtful and not `jsonOnly`.
- The doubtful agreement and the overall agreement (clear plus doubtful) are printed and stored as separate figures,
  for information.
