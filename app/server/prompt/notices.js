'use strict';

// The few user-facing strings the SERVER authors (the model otherwise answers in
// the user's own language). Localized to the request `language` — the integration
// forwards the HA conversation language, e.g. "uk" / "en" / "pl-PL". An absent or
// unsupported language falls back to English. The English degrade wording keeps
// "couldn't finish" / "try again" — callers and tests key off it.
const DEGRADE_TEXT = {
  en: "Sorry — I couldn't finish that response. Please try again.",
  uk: 'Вибач — не вдалося завершити відповідь. Спробуй ще раз.',
  pl: 'Przepraszam — nie udało się dokończyć odpowiedzi. Spróbuj ponownie.',
  de: 'Entschuldigung — ich konnte diese Antwort nicht abschließen. Bitte versuche es noch einmal.',
  fr: "Désolé — je n'ai pas pu terminer cette réponse. Réessaie, s'il te plaît.",
  es: 'Lo siento — no pude terminar esa respuesta. Inténtalo de nuevo, por favor.',
  it: 'Scusa — non sono riuscito a completare la risposta. Riprova, per favore.',
  pt: 'Desculpa — não consegui terminar essa resposta. Tenta novamente, por favor.',
  nl: 'Sorry — ik kon dat antwoord niet afmaken. Probeer het opnieuw.',
};
// Derived from the notice table so the supported set can never drift from the
// strings: adding a language = adding it to DEGRADE_TEXT + budgetNotice only.
const SUPPORTED_LANGS = new Set(Object.keys(DEGRADE_TEXT));
function langOf(raw) {
  const code = String(raw || '').slice(0, 2).toLowerCase();
  return SUPPORTED_LANGS.has(code) ? code : 'en';
}
const budgetNotice = (lang, limit, agentName) => ({
  en: `I've reached today's ${agentName} usage budget ($${limit}), so I'm paused until tomorrow. You can raise "Chat daily budget (USD)" in the add-on options.`,
  uk: `Досягнуто денного бюджету ${agentName} ($${limit}) — я на паузі до завтра. Збільшити його можна в опції додатка «Chat daily budget (USD)».`,
  pl: `Osiągnięto dzienny budżet ${agentName} ($${limit}) — jestem wstrzymany do jutra. Możesz go zwiększyć w opcji dodatku „Chat daily budget (USD)”.`,
  de: `Ich habe das heutige ${agentName}-Nutzungsbudget ($${limit}) erreicht und pausiere bis morgen. Du kannst „Chat daily budget (USD)" in den Add-on-Optionen erhöhen.`,
  fr: `J'ai atteint le budget d'utilisation ${agentName} d'aujourd'hui ($${limit}), je suis donc en pause jusqu'à demain. Tu peux augmenter « Chat daily budget (USD) » dans les options du module.`,
  es: `He alcanzado el presupuesto de uso de ${agentName} de hoy ($${limit}), así que estoy en pausa hasta mañana. Puedes aumentar "Chat daily budget (USD)" en las opciones del add-on.`,
  it: `Ho raggiunto il budget d'uso di ${agentName} di oggi ($${limit}), quindi sono in pausa fino a domani. Puoi aumentare "Chat daily budget (USD)" nelle opzioni dell'add-on.`,
  pt: `Atingi o orçamento de uso do ${agentName} de hoje ($${limit}), por isso estou pausado até amanhã. Podes aumentar "Chat daily budget (USD)" nas opções do add-on.`,
  nl: `Ik heb het ${agentName}-gebruiksbudget van vandaag ($${limit}) bereikt en pauzeer tot morgen. Je kunt "Chat daily budget (USD)" in de add-on-opties verhogen.`,
}[lang]);

module.exports = { DEGRADE_TEXT, SUPPORTED_LANGS, langOf, budgetNotice };
