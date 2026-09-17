'use strict';

// The texts the server writes itself. The engine's name comes from its branding;
// with the Claude names every text is the one the add-on has always sent.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEGRADE_TEXT, SUPPORTED_LANGS, langOf, budgetNotice } = require('../../server/prompt/notices');

// Recorded before the names became branding data, with a limit of 7.5.
const CLAUDE_BUDGET_NOTICE = {
  en: `I've reached today's Claude usage budget ($7.5), so I'm paused until tomorrow. You can raise "Chat daily budget (USD)" in the add-on options.`,
  uk: `Досягнуто денного бюджету Claude ($7.5) — я на паузі до завтра. Збільшити його можна в опції додатка «Chat daily budget (USD)».`,
  pl: `Osiągnięto dzienny budżet Claude ($7.5) — jestem wstrzymany do jutra. Możesz go zwiększyć w opcji dodatku „Chat daily budget (USD)”.`,
  de: `Ich habe das heutige Claude-Nutzungsbudget ($7.5) erreicht und pausiere bis morgen. Du kannst „Chat daily budget (USD)" in den Add-on-Optionen erhöhen.`,
  fr: `J'ai atteint le budget d'utilisation Claude d'aujourd'hui ($7.5), je suis donc en pause jusqu'à demain. Tu peux augmenter « Chat daily budget (USD) » dans les options du module.`,
  es: `He alcanzado el presupuesto de uso de Claude de hoy ($7.5), así que estoy en pausa hasta mañana. Puedes aumentar "Chat daily budget (USD)" en las opciones del add-on.`,
  it: `Ho raggiunto il budget d'uso di Claude di oggi ($7.5), quindi sono in pausa fino a domani. Puoi aumentare "Chat daily budget (USD)" nelle opzioni dell'add-on.`,
  pt: `Atingi o orçamento de uso do Claude de hoje ($7.5), por isso estou pausado até amanhã. Podes aumentar "Chat daily budget (USD)" nas opções do add-on.`,
  nl: `Ik heb het Claude-gebruiksbudget van vandaag ($7.5) bereikt en pauzeer tot morgen. Je kunt "Chat daily budget (USD)" in de add-on-opties verhogen.`,
};

test('with the Claude name every budget notice is unchanged', () => {
  assert.deepEqual([...SUPPORTED_LANGS].sort(), Object.keys(CLAUDE_BUDGET_NOTICE).sort());
  for (const [lang, text] of Object.entries(CLAUDE_BUDGET_NOTICE)) {
    assert.equal(budgetNotice(lang, 7.5, 'Claude'), text, lang);
  }
});

test('every budget notice names the engine it is given, and only that one', () => {
  for (const lang of SUPPORTED_LANGS) {
    const text = budgetNotice(lang, 2, 'Neutral');
    assert.ok(text.includes('Neutral'), lang);
    assert.ok(!/claude/i.test(text), lang);
    assert.ok(text.includes('$2'), lang);
  }
});

test('the degrade texts name no engine, and an unknown language falls back to English', () => {
  for (const text of Object.values(DEGRADE_TEXT)) assert.ok(!/claude/i.test(text));
  assert.equal(langOf('pl-PL'), 'pl');
  assert.equal(langOf('xx'), 'en');
  assert.equal(langOf(undefined), 'en');
});
