/**
 * What is sent to an external provider, said once per language and shared by `msum provider use` (command line) and the
 * disclosure of the web (RNF-02). It is the text whose version is `CONSENT_TEXT_VERSION`: when it changes in substance (a new
 * kind of data goes out), raise that version so the consents given for the old text stop counting.
 *
 * Version 2 added the phone numbers of the contacts that were not saved and the transcripts of voice notes.
 */
export const DISCLOSURE_SENDS = {
  en: 'The text of the conversations of your digests: the messages, the names of the chats and of the contacts as they appear in them, the phone numbers of the contacts you have not saved, the transcripts of voice notes, and your name as the owner. Conversations that match localOnlyPatterns are never sent (only Ollama sees them).',
  es: 'El texto de las conversaciones de tus resúmenes: los mensajes, los nombres de los chats y de los contactos como aparecen en ellos, los números de teléfono de los contactos que no guardaste, las transcripciones de las notas de voz, y tu nombre como dueño. Las conversaciones que coinciden con localOnlyPatterns nunca se envían (solo Ollama las ve).',
} as const
