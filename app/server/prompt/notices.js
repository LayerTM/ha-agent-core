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

// Why a device the model named did not become a proposal (targets.js), one
// sentence per name. Quoted names are the model's own words for the device.
const TARGET_TEXT = {
  en: {
    unknown: (n) => `I couldn't find a device called “${n}” among the devices Home Assistant shares with me.`,
    ambiguous: (n, c) => `“${n}” matches more than one device${c ? ` (${c})` : ''} — which one do you mean?`,
    unpinned: (n) => `I couldn't tell which device “${n}” is — please use its full name.`,
    unavailable: () => "I couldn't look the devices up in Home Assistant, so I haven't prepared anything. Please try again.",
  },
  uk: {
    unknown: (n) => `Не знайшов пристрою «${n}» серед тих, що Home Assistant мені відкриває.`,
    ambiguous: (n, c) => `«${n}» відповідає кільком пристроям${c ? ` (${c})` : ''} — який саме?`,
    unpinned: (n) => `Не вдалося визначити, який саме пристрій «${n}», — назви його повним іменем.`,
    unavailable: () => 'Не вдалося знайти пристрої в Home Assistant, тож я нічого не підготував. Спробуй ще раз.',
  },
  pl: {
    unknown: (n) => `Nie znalazłem urządzenia „${n}” wśród urządzeń udostępnionych mi przez Home Assistant.`,
    ambiguous: (n, c) => `„${n}” pasuje do więcej niż jednego urządzenia${c ? ` (${c})` : ''} — o które chodzi?`,
    unpinned: (n) => `Nie wiem, które to urządzenie „${n}” — użyj jego pełnej nazwy.`,
    unavailable: () => 'Nie udało się wyszukać urządzeń w Home Assistant, więc niczego nie przygotowałem. Spróbuj ponownie.',
  },
  de: {
    unknown: (n) => `Ich habe kein Gerät namens „${n}“ unter den Geräten gefunden, die Home Assistant mir freigibt.`,
    ambiguous: (n, c) => `„${n}“ passt zu mehr als einem Gerät${c ? ` (${c})` : ''} — welches meinst du?`,
    unpinned: (n) => `Ich konnte nicht erkennen, welches Gerät „${n}“ ist — bitte nenne seinen vollen Namen.`,
    unavailable: () => 'Ich konnte die Geräte in Home Assistant nicht nachschlagen und habe daher nichts vorbereitet. Bitte versuche es noch einmal.',
  },
  fr: {
    unknown: (n) => `Je n'ai trouvé aucun appareil nommé « ${n} » parmi ceux que Home Assistant me partage.`,
    ambiguous: (n, c) => `« ${n} » correspond à plusieurs appareils${c ? ` (${c})` : ''} — lequel veux-tu dire ?`,
    unpinned: (n) => `Je n'ai pas pu déterminer quel appareil est « ${n} » — utilise son nom complet.`,
    unavailable: () => "Je n'ai pas pu rechercher les appareils dans Home Assistant, je n'ai donc rien préparé. Réessaie, s'il te plaît.",
  },
  es: {
    unknown: (n) => `No encontré ningún dispositivo llamado «${n}» entre los que Home Assistant comparte conmigo.`,
    ambiguous: (n, c) => `«${n}» coincide con más de un dispositivo${c ? ` (${c})` : ''} — ¿cuál quieres decir?`,
    unpinned: (n) => `No pude saber qué dispositivo es «${n}» — usa su nombre completo.`,
    unavailable: () => 'No pude buscar los dispositivos en Home Assistant, así que no he preparado nada. Inténtalo de nuevo, por favor.',
  },
  it: {
    unknown: (n) => `Non ho trovato nessun dispositivo chiamato «${n}» tra quelli che Home Assistant condivide con me.`,
    ambiguous: (n, c) => `«${n}» corrisponde a più di un dispositivo${c ? ` (${c})` : ''} — quale intendi?`,
    unpinned: (n) => `Non sono riuscito a capire quale dispositivo sia «${n}» — usa il suo nome completo.`,
    unavailable: () => 'Non sono riuscito a cercare i dispositivi in Home Assistant, quindi non ho preparato nulla. Riprova, per favore.',
  },
  pt: {
    unknown: (n) => `Não encontrei nenhum dispositivo chamado «${n}» entre os que o Home Assistant partilha comigo.`,
    ambiguous: (n, c) => `«${n}» corresponde a mais de um dispositivo${c ? ` (${c})` : ''} — qual queres dizer?`,
    unpinned: (n) => `Não consegui perceber que dispositivo é «${n}» — usa o nome completo.`,
    unavailable: () => 'Não consegui procurar os dispositivos no Home Assistant, por isso não preparei nada. Tenta novamente, por favor.',
  },
  nl: {
    unknown: (n) => `Ik heb geen apparaat met de naam „${n}” gevonden onder de apparaten die Home Assistant met mij deelt.`,
    ambiguous: (n, c) => `„${n}” past bij meer dan één apparaat${c ? ` (${c})` : ''} — welke bedoel je?`,
    unpinned: (n) => `Ik kon niet bepalen welk apparaat „${n}” is — gebruik de volledige naam.`,
    unavailable: () => 'Ik kon de apparaten niet opzoeken in Home Assistant, dus ik heb niets voorbereid. Probeer het opnieuw.',
  },
};
const targetNotice = (lang, problems) => {
  const table = TARGET_TEXT[lang] || TARGET_TEXT.en;
  return problems.map(({ problem, ref, candidates }) => table[problem](
    ref, candidates.map((c) => `${c.name}: ${c.id}`).join(', '),
  )).join(' ');
};

module.exports = { DEGRADE_TEXT, SUPPORTED_LANGS, langOf, budgetNotice, targetNotice, TARGET_TEXT };
