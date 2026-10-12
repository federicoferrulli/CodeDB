'use strict';
// I pannelli riusano l'app in documenti separati: i test entrano nello stesso controller.
async function install(page) {
  await page.addInitScript(versione => {
    localStorage.setItem('codedb:onboarding', JSON.stringify({ visto: true, versioneVista: versione, checklistChiusa: true }));
    window.paneDocument = async (index = 0) => {
      document.querySelector('#tab-body')?.classList.remove('hidden');
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const frames = [...document.querySelectorAll('.pane-runtime')];
        const frame = index < 0 ? frames.at(index) : frames[index];
        if (frame?.codedbPanel.ready) return frame.contentDocument;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Runtime del pannello ${index} non pronto`);
    };
  }, require('../package.json').version);
}
async function frame(page, index = 0) {
  await page.waitForFunction(i => [...document.querySelectorAll('.pane-runtime')].at(i)?.codedbPanel.ready, index);
  return page.locator('.pane-runtime').nth(index).contentFrame();
}
module.exports = { install, frame };
