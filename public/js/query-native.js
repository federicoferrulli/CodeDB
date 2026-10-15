import { tabs, activeTab, switchTab } from './tabs.js';
import { $, toast } from './utils.js';

export function renderNativeTargets() {
  const select = $('#query-native-connection');
  if (!select) return;
  const precedente = select.value;
  select.replaceChildren(new Option('Scegli una connessione SQL aperta', ''));
  for (const t of tabs.list.filter(t => t.state.connected && ['mysql', 'postgresql'].includes(t.state.dbType))) {
    select.add(new Option(`${t.label} · ${t.state.dbType === 'mysql' ? 'MySQL' : 'PostgreSQL'}`, t.id));
  }
  select.value = precedente;
  renderDatabases();
  const engine = $('#query-target-engine');
  for (const option of engine.options) {
    const estraneo = ['mysql', 'postgresql', 'mongodb'].includes(option.value) && option.value !== activeTab()?.state.dbType;
    option.disabled = estraneo;
    option.hidden = estraneo;
  }
  if (engine.selectedOptions[0]?.disabled) engine.value = 'auto';
}

function renderDatabases() {
  const target = tabs.list.find(t => t.id === $('#query-native-connection')?.value);
  const select = $('#query-native-database');
  const precedente = select.value;
  select.replaceChildren(new Option('Scegli database / schema', ''));
  for (const db of target?.state.databases || []) select.add(new Option(db.name, db.name));
  select.value = [...select.options].some(o => o.value === precedente && precedente) ? precedente : target?.state.db || '';
  $('#query-native-open').disabled = !target || !select.value;
}

export function initNativeTargets() {
  $('#query-target-btn')?.addEventListener('click', renderNativeTargets);
  $('#query-native-connection')?.addEventListener('change', renderDatabases);
  $('#query-native-database')?.addEventListener('change', () => {
    $('#query-native-open').disabled = !$('#query-native-database').value;
  });
  $('#query-native-open')?.addEventListener('click', async () => {
    const id = $('#query-native-connection').value;
    const db = $('#query-native-database').value;
    const code = $('#query-editor-input').value;
    const [{ saveWorkspaceInputs }, { openDbTab }] = await Promise.all([import('./workspace.js'), import('./colltabs.js')]);
    const target = tabs.list.find(t => t.id === id && t.state.connected);
    if (!target || !['mysql', 'postgresql'].includes(target.state.dbType) || !target.state.databases.some(d => d.name === db)) {
      toast('La destinazione SQL non è più disponibile. Aggiorna la connessione e scegli nuovamente il bersaglio.', true);
      renderNativeTargets();
      return;
    }
    saveWorkspaceInputs();
    switchTab(id);
    // Un nuovo documento conserva sia l'originale sia le bozze già aperte sul motore SQL.
    openDbTab(db, { query: { code, engine: target.state.dbType } });
    $('#query-target-menu').classList.add('hidden');
    $('#query-target-btn').setAttribute('aria-expanded', 'false');
    $('#query-editor-input').focus();
    toast(`Query pronta su ${target.label} / ${db}. Esegui per interrogare i dati di questa destinazione.`);
  });
}
