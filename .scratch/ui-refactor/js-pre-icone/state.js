import { activeTab, freshState } from './tabs.js';

// `state` è un Proxy che delega allo stato del tab attivo: i moduli storici
// continuano a leggere/scrivere un singolo oggetto, ma il cambio tab scambia
// l'oggetto sottostante. La forma dello stato è definita in freshState()
// (tabs.js). Lo stato "staccato" copre l'istante in cui nessun tab è aperto.
const detached = freshState();

function target() {
  const tab = activeTab();
  return tab ? tab.state : detached;
}

export const state = new Proxy({}, {
  get: (_, key) => target()[key],
  set: (_, key, value) => { target()[key] = value; return true; },
  has: (_, key) => key in target(),
  deleteProperty: (_, key) => { delete target()[key]; return true; },
  ownKeys: () => Reflect.ownKeys(target()),
  getOwnPropertyDescriptor: (_, key) => Object.getOwnPropertyDescriptor(target(), key),
});
