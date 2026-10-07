'use strict';

// Azioni utente sui componenti Arc. Il selettore ricevuto identifica il modello
// conservato dal controller; non usiamo force o eventi simulati per scegliere.
async function scegliArc(page, selector, value) {
  const model = page.locator(selector).and(page.locator('select'));
  const label = await model.evaluate((select, wanted) => [...select.options].find(option => option.value === wanted)?.label, value);
  if (label === undefined) throw new Error(`Opzione assente: ${selector} = ${value}`);
  await model.locator('xpath=following-sibling::*[1]').getByRole('combobox').click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.locator('[data-arc-select-popup]').waitFor({ state: 'detached' });
}

async function spuntaArc(page, selector, checked) {
  const model = page.locator(selector).and(page.locator('input[type="checkbox"]'));
  if (await model.isChecked() !== checked) await model.locator('xpath=following-sibling::*[1]').getByRole('checkbox').click();
}

module.exports = { scegliArc, spuntaArc };
