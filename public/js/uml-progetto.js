import { mountArcControls } from '../arc/ui.js';
import { $, esc, emit, showToast, chiediTesto } from './utils.js';
import { leggiOperazioni, tabelleProgettate, metadatiProgettati } from './uml-progetto-modello.js';
import { invalidaSchemaIntellisense } from './autocomplete.js';
import { closeCollTabsWhere, updateCollTabs } from './colltabs.js';

const etichette = {
  createTable: 'Crea tabella', addColumn: 'Aggiungi colonna', alterColumn: 'Modifica colonna',
  dropColumn: 'Elimina colonna', renameTable: 'Rinomina tabella', dropTable: 'Elimina tabella',
  addPrimaryKey: 'Aggiungi chiave primaria', addForeignKey: 'Crea relazione (FK)', replaceForeignKey: 'Modifica relazione (FK)', dropForeignKey: 'Elimina relazione (FK)',
  replacePrimaryKey: 'Modifica chiave primaria', dropPrimaryKey: 'Elimina chiave primaria',
};

// Un pannello, un documento catturato. Le risposte tardive non cambiano un altro tab.
export function creaProgettista({ contesto, documento, tabelle, modifica, aggiornaSchema }) {
  const el = $('#uml-progetto');
  let ctx, doc, info = {}, preview = null, busy = false, generation = 0, prepared = '';
  const corrente = () => doc === documento() && ctx?.tabId === contesto().tabId && ctx?.db === contesto().db && ctx?.connId === contesto().connId;
  const operazioni = () => doc.progetto || [];
  const passiForm = () => {
    const index = el.querySelector('[data-index]')?.value || '';
    return index === '' ? operazioni() : operazioni().slice(0, +index);
  };
  const nomi = () => [...tabelleProgettate(tabelle(), passiForm()).keys()];
  const options = (values) => values.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const avviso = (text) => { el.querySelector('[data-error]').textContent = text; };
  const cambia = (ops) => { preview = null; modifica(leggiOperazioni(ops)); disegnaCoda(); };
  function aggiornaTabelle() {
    for (const selector of ['[data-table]', '[data-target]']) {
      const select = el.querySelector(selector), selected = select.value;
      select.innerHTML = options(nomi());
      if (nomi().includes(selected)) select.value = selected;
    }
  }
  function rigaColonna(c = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input aria-label="Nome colonna" data-col="name" required value="${esc(c.name || '')}"></td>
      <td><input aria-label="Tipo colonna" data-col="type" required list="${ctx.dbType === 'mysql' ? 'mysql' : 'postgres'}-types" value="${esc(c.type || 'integer')}"></td>
      <td><input aria-label="Ammette NULL" data-col="nullable" type="checkbox" ${c.nullable !== false ? 'checked' : ''}></td>
      <td><input aria-label="Valore predefinito" data-col="default" value="${esc(c.default || '')}"></td>
      <td><input aria-label="Auto incremento" data-col="autoIncrement" type="checkbox" ${c.autoIncrement ? 'checked' : ''}></td>
      <td><input aria-label="Chiave primaria" data-col="primaryKey" type="checkbox" ${c.primaryKey ? 'checked' : ''}></td>
      <td><button type="button" data-delete-column aria-label="Rimuovi colonna dalla bozza">×</button></td>`;
    mountArcControls(tr);
    tr.querySelector('[data-delete-column]').onclick = () => tr.remove();
    el.querySelector('tbody').append(tr);
  }
  function colonne() {
    return [...el.querySelectorAll('tbody tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-col]')]
      .map((i) => [i.dataset.col, i.type === 'checkbox' ? i.checked : i.value.trim()])));
  }
  function disegnaCoda() {
    const list = el.querySelector('[data-queue]');
    list.innerHTML = operazioni().map((o, i) => `<li><span>${esc(etichette[o.kind])}: <strong>${esc(o.table)}</strong>${o.name ? ` · ${esc(o.name)}` : ''}</span>
      <button type="button" data-edit="${i}">Modifica</button><button type="button" data-remove="${i}" aria-label="Rimuovi operazione ${i + 1}">×</button></li>`).join('') || '<li>Nessuna modifica in bozza.</li>';
    mountArcControls(list);
    list.querySelectorAll('[data-remove]').forEach((b) => { b.onclick = () => cambia(operazioni().filter((_, i) => i !== +b.dataset.remove)); });
    list.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => compila(operazioni()[+b.dataset.edit], +b.dataset.edit); });
    el.querySelector('[data-preview]').disabled = busy || !operazioni().length;
    el.querySelector('[data-apply]').disabled = busy || !preview;
    aggiornaTabelle();
    $('#uml-progetta-btn').textContent = `Progetta schema${operazioni().length ? ` (${operazioni().length})` : ''}`;
  }
  async function metadati(table) {
    // Modificando un passo si vede lo schema PRIMA di quel passo; aggiungendo
    // un'operazione si vede invece l'intera bozza, comprese le nuove colonne.
    const ops = passiForm(), state = tabelleProgettate(tabelle(), ops).get(table);
    if (!state) throw new Error('Tabella non presente in questo punto della bozza.');
    const base = state.origine == null ? { fields: [], relazioni: [] }
      : await emit('uml:table', { tabId: ctx.tabId, db: ctx.db, coll: state.origine });
    return metadatiProgettati(base, table, state, ops, ctx.db);
  }
  async function aggiornaForm() {
    const my = ++generation;
    const kind = el.querySelector('[data-kind]').value;
    const table = el.querySelector('[data-table]').value;
    el.querySelector('[data-table-label]').hidden = kind === 'createTable';
    el.querySelector('[data-name-label]').hidden = !['createTable', 'renameTable', 'addForeignKey', 'replaceForeignKey'].includes(kind);
    el.querySelector('[data-columns-wrap]').hidden = !['createTable', 'addColumn', 'alterColumn'].includes(kind);
    el.querySelector('[data-add-column]').hidden = kind !== 'createTable';
    el.querySelector('[data-field-label]').hidden = !['alterColumn', 'dropColumn'].includes(kind);
    el.querySelector('[data-fk-label]').hidden = !['dropForeignKey', 'replaceForeignKey'].includes(kind);
    el.querySelector('[data-relation]').hidden = !['addForeignKey', 'replaceForeignKey'].includes(kind);
    el.querySelector('[data-key-label]').hidden = !['addPrimaryKey', 'replacePrimaryKey', 'addForeignKey', 'replaceForeignKey'].includes(kind);
    el.querySelector('tbody').innerHTML = '';
    avviso('');
    if (kind === 'createTable') { rigaColonna({ name: 'id', type: 'integer', nullable: false, primaryKey: true, autoIncrement: true }); return; }
    if (kind === 'addColumn') rigaColonna();
    if (!table) return;
    try {
      const loaded = await metadati(table);
      if (!corrente() || my !== generation) return;
      info = loaded;
      el.querySelector('[data-field]').innerHTML = options(info.fields.map((f) => f.name));
      el.querySelector('[data-fk]').innerHTML = options(info.relazioni.map((r) => r.nome));
      if (kind === 'alterColumn') scegliCampo();
      if (kind === 'replaceForeignKey') scegliVincolo();
    } catch (err) { if (corrente() && my === generation) avviso(err.message); }
  }
  function scegliCampo() {
    const f = info.fields?.find((f) => f.name === el.querySelector('[data-field]').value);
    el.querySelector('tbody').innerHTML = '';
    if (f) {
      rigaColonna({ ...f, type: f.types?.[0], primaryKey: f.key === 'PRI' });
      // PK e identity si conservano: cambiare una colonna non deve rimuoverli.
      el.querySelector('[data-col="primaryKey"]').disabled = true;
      el.querySelector('[data-col="autoIncrement"]').disabled = true;
    }
  }
  function scegliVincolo() {
    if (el.querySelector('[data-kind]').value !== 'replaceForeignKey') return;
    const r = info.relazioni?.find((r) => r.nome === el.querySelector('[data-fk]').value);
    if (!r) return;
    el.querySelector('[data-name]').value = r.nome;
    el.querySelector('[data-target]').value = r.tabella;
    el.querySelector('[data-key]').value = r.coppie.map((p) => p.campo).join(', ');
    el.querySelector('[data-references]').value = r.coppie.map((p) => p.colonna).join(', ');
    el.querySelector('[data-ondelete]').value = r.onDelete || 'NO ACTION';
    el.querySelector('[data-onupdate]').value = r.onUpdate || 'NO ACTION';
    if (r.db && r.db !== ctx.db) avviso('Questo vincolo punta a un altro schema. Il progettista gestisce relazioni nello schema corrente; usa una DDL esplicita per questo vincolo.');
  }
  async function compila(op, index = '') {
    const captured = doc;
    el.querySelector('[data-index]').value = index;
    aggiornaTabelle();
    el.querySelector('[data-kind]').value = op.kind;
    el.querySelector('[data-table]').value = op.table;
    const updating = aggiornaForm(), my = generation;
    await updating;
    if (!corrente() || doc !== captured || my !== generation) return;
    el.querySelector('[data-name]').value = op.kind === 'createTable' ? op.table : op.name || '';
    if (op.columns && op.kind === 'createTable') {
      el.querySelector('tbody').innerHTML = ''; op.columns.forEach(rigaColonna);
    }
    if (op.column && ['addColumn', 'alterColumn'].includes(op.kind)) {
      el.querySelector('[data-field]').value = op.oldName || '';
      el.querySelector('tbody').innerHTML = ''; rigaColonna(op.column);
      if (op.kind === 'alterColumn') {
        el.querySelector('[data-col="primaryKey"]').disabled = true;
        el.querySelector('[data-col="autoIncrement"]').disabled = true;
      }
    }
    if (op.kind === 'dropColumn') el.querySelector('[data-field]').value = op.name;
    if (['dropForeignKey', 'replaceForeignKey'].includes(op.kind)) el.querySelector('[data-fk]').value = op.oldName || op.name;
    el.querySelector('[data-key]').value = op.kind !== 'createTable' ? (op.columns || []).join(', ') : '';
    el.querySelector('[data-target]').value = op.target || nomi()[0] || '';
    el.querySelector('[data-references]').value = (op.references || []).join(', ');
    const original = info.relazioni?.find((r) => r.nome === op.oldName);
    el.querySelector('[data-ondelete]').value = op.onDelete || original?.onDelete || 'NO ACTION';
    el.querySelector('[data-onupdate]').value = op.onUpdate || original?.onUpdate || 'NO ACTION';
  }
  function bloque(val) {
    busy = val;
    el.querySelectorAll('button, input, select').forEach((e) => { e.disabled = val; });
    el.querySelector('[data-apply]').disabled = val || !preview;
    el.querySelector('[data-preview]').disabled = val || !operazioni().length;
    if (!val && el.querySelector('[data-kind]').value === 'alterColumn') {
      el.querySelectorAll('[data-col="primaryKey"], [data-col="autoIncrement"]').forEach((e) => { e.disabled = true; });
    }
  }
  async function anteprima() {
    if (!corrente()) return;
    const captured = doc;
    bloque(true); avviso('Preparazione dell’anteprima…');
    try {
      const res = await emit('uml:preview', { tabId: ctx.tabId, db: ctx.db, operations: operazioni() });
      if (!corrente() || doc !== captured) return;
      preview = res;
      prepared = JSON.stringify(operazioni());
      el.querySelector('[data-sql]').textContent = res.steps.map((s) => `${s.warning ? `-- ${s.warning}\n` : ''}${s.sql};`).join('\n\n');
      avviso('Controlla le istruzioni. Verranno eseguite nell’ordine mostrato; in caso di errore le istruzioni già riuscite restano applicate.');
    } catch (err) { if (corrente() && doc === captured) avviso(err.message); }
    finally { if (corrente() && doc === captured) bloque(false); }
  }
  async function applica() {
    if (!preview || !corrente() || busy || prepared !== JSON.stringify(operazioni())) return;
    const captured = doc, target = { ...ctx }, token = preview.token, steps = preview.steps;
    const planned = [...operazioni()];
    const confirmation = await chiediTesto({ titolo: 'Applica progetto al database',
      sottotitolo: `Destinazione: ${target.db}. Le operazioni possono modificare o eliminare dati. Scrivi APPLICA per eseguire l’SQL dell’anteprima.`, etichetta: 'Conferma', valore: '' });
    if (confirmation !== 'APPLICA' || !corrente() || doc !== captured || token !== preview?.token) return;
    bloque(true);
    try {
      const res = await emit('uml:apply', { tabId: target.tabId, db: target.db, token });
      if (res.status === 'in_corso') {
        if (corrente() && doc === captured) avviso('Applicazione ancora in corso. Premi Applica per recuperarne l’esito senza ripetere le istruzioni.');
        return;
      }
      const complete = new Set(planned.map((_, index) => index).filter((index) => {
        const forOperation = steps.filter((s) => s.index === index);
        return res.results.filter((r) => r.index === index && r.status === 'applicato').length === forOperation.length;
      }));
      const applicate = planned.filter((_, i) => complete.has(i));
      invalidaSchemaIntellisense(target.db);
      if (res._state) {
        const st = res._state;
        st.schemaDirty = true; st.dbSchema = null;
        for (const op of applicate) {
          if (op.kind === 'renameTable') {
            updateCollTabs((ct) => { if (ct.db === target.db && ct.coll === op.table) ct.coll = op.name; }, st);
            if (st.db === target.db && st.coll === op.table) st.coll = op.name;
          }
          if (op.kind === 'dropTable') closeCollTabsWhere((ct) => ct.db === target.db && ct.coll === op.table, st);
        }
      }
      await aggiornaSchema(target, applicate, captured);
      if (!corrente() || doc !== captured) return;
      preview = null; disegnaCoda();
      el.querySelector('[data-sql]').textContent = res.results.map((r) => `${r.status === 'applicato' ? 'APPLICATO' : 'DA VERIFICARE'}: ${r.sql}${r.error ? `\n${r.error}` : ''}`).join('\n\n');
      avviso(res.status === 'completato' ? 'Progetto applicato. Schema riletto dal database.' : `Applicazione ${res.status}. ${res.error || ''} Controlla lo schema prima di preparare un’altra anteprima.`);
    } catch (err) {
      // Non ritentare alla cieca: il token sul server impedisce la doppia esecuzione.
      if (corrente() && doc === captured) avviso(`Esito non ricevuto: ${err.message}. Premi di nuovo Applica per recuperare l’esito dello stesso piano.`);
    } finally { if (corrente() && doc === captured) bloque(false); }
  }
  function apri(op) {
    if (busy) return;
    ctx = { ...contesto() }; doc = documento();
    if (!['mysql', 'postgres', 'postgresql'].includes(ctx.dbType)) return;
    preview = null;
    el.classList.remove('hidden'); $('#uml-progetta-btn').setAttribute('aria-expanded', 'true');
    el.innerHTML = `<div class="uml-progetto-testa"><strong>Progetto dello schema · ${esc(ctx.db)}</strong><span>Bozza locale: il database cambia solo con «Applica».</span><button type="button" data-close aria-label="Chiudi progettazione">×</button></div>
      <div class="uml-progetto-corpo"><form data-form>
        <input type="hidden" data-index value="">
        <div class="uml-progetto-riga"><label>Operazione<select data-kind>${Object.entries(etichette).map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}</select></label>
        <label data-table-label>Tabella<select data-table>${options(nomi())}</select></label>
        <label data-name-label>Nome<input data-name maxlength="63"></label></div>
        <label data-field-label>Colonna<select data-field></select></label>
        <label data-fk-label>Vincolo<select data-fk></select></label>
        <div data-columns-wrap class="uml-progetto-colonne"><table><thead><tr><th>Nome</th><th>Tipo</th><th>NULL</th><th>Predefinito</th><th>Auto</th><th>PK</th><th></th></tr></thead><tbody></tbody></table><button type="button" data-add-column>Aggiungi colonna</button></div>
        <label data-key-label>Colonne, in ordine (separate da virgola)<input data-key placeholder="cliente_id"></label>
        <div data-relation class="uml-progetto-riga"><label>Tabella riferita<select data-target>${options(nomi())}</select></label>
        <label>Colonne riferite, nello stesso ordine<input data-references placeholder="id"></label>
        <label>Su eliminazione<select data-ondelete>${options(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', ...(ctx.dbType !== 'mysql' ? ['SET DEFAULT'] : [])])}</select></label>
        <label>Su aggiornamento<select data-onupdate>${options(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', ...(ctx.dbType !== 'mysql' ? ['SET DEFAULT'] : [])])}</select></label></div>
        <button type="submit">Salva nella bozza</button>
      </form><div class="uml-progetto-revisione"><strong>Modifiche da applicare</strong><ol data-queue></ol>
      <div class="uml-progetto-riga"><button type="button" data-preview>Anteprima SQL</button><button type="button" data-apply disabled>Applica al database…</button></div>
      <p data-error role="status" aria-live="polite"></p><pre data-sql tabindex="0" aria-label="SQL ed esito dell’applicazione"></pre></div></div>`;
    mountArcControls(el);
    el.querySelector('[data-close]').onclick = chiudi;
    el.querySelector('[data-kind]').onchange = () => { el.querySelector('[data-index]').value = ''; aggiornaTabelle(); aggiornaForm(); };
    el.querySelector('[data-table]').onchange = aggiornaForm;
    el.querySelector('[data-field]').onchange = scegliCampo;
    el.querySelector('[data-fk]').onchange = scegliVincolo;
    el.querySelector('[data-add-column]').onclick = () => rigaColonna();
    el.querySelector('[data-preview]').onclick = anteprima;
    el.querySelector('[data-apply]').onclick = applica;
    el.querySelector('[data-form]').onsubmit = (event) => {
      event.preventDefault(); if (!corrente() || busy) return;
      const value = (s) => el.querySelector(`[data-${s}]`).value.trim();
      const list = (s) => value(s).split(',').map((s) => s.trim()).filter(Boolean);
      const kind = value('kind');
      const original = info.relazioni?.find(r => r.nome === value('fk'));
      if (kind === 'replaceForeignKey' && original?.db && original.db !== ctx.db) {
        avviso('Il vincolo punta a un altro schema: usa una DDL esplicita per modificarlo.'); return;
      }
      const next = { kind, table: kind === 'createTable' ? value('name') : value('table'), name: value('name'),
        oldName: value('field'), columns: kind === 'createTable' ? colonne() : list('key'), column: colonne()[0],
        target: value('target'), references: list('references'), onDelete: value('ondelete'), onUpdate: value('onupdate') };
      if (kind === 'dropColumn') next.name = value('field');
      if (kind === 'dropForeignKey') next.name = value('fk');
      if (kind === 'replaceForeignKey') next.oldName = value('fk');
      if (!next.table) { avviso('Indica la tabella.'); return; }
      const ops = [...operazioni()]; const index = value('index');
      if (index === '' && ops.length >= 100) { avviso('La bozza contiene già 100 modifiche. Applica o rimuovi quelle presenti prima di aggiungerne altre.'); return; }
      if (index === '' && kind === 'createTable') { next.x = 80 + ops.filter((o) => o.kind === 'createTable').length * 320; next.y = 80; }
      if (index !== '') ops[+index] = { ...ops[+index], ...next }; else ops.push(next);
      el.querySelector('[data-index]').value = ''; cambia(ops);
      aggiornaForm();
      el.querySelector('[data-sql]').textContent = '';
      avviso('Modifica salvata nella bozza. Nessuna istruzione eseguita sul database.');
    };
    disegnaCoda();
    const index = op ? operazioni().indexOf(op) : -1;
    if (op) compila(op, index >= 0 ? index : '').catch((err) => avviso(err.message)); else aggiornaForm();
  }
  function chiudi() {
    if (busy) { showToast('Attendi l’esito dell’operazione in corso.', 'warning'); return; }
    generation++; el.classList.add('hidden'); $('#uml-progetta-btn').setAttribute('aria-expanded', 'false');
  }
  function sincronizza() {
    const sql = ['mysql', 'postgres', 'postgresql'].includes(contesto().dbType);
    $('#uml-progetta-btn').classList.toggle('hidden', !sql);
    if (!corrente()) { generation++; el.classList.add('hidden'); busy = false; preview = null; }
    if (!busy && preview && prepared !== JSON.stringify(operazioni())) { preview = null; el.querySelector('[data-apply]').disabled = true; }
    $('#uml-progetta-btn').textContent = `Progetta schema${documento().progetto?.length ? ` (${documento().progetto.length})` : ''}`;
  }
  return { apri, sincronizza, get occupato() { return busy && corrente(); }, get aperto() { return !el.classList.contains('hidden') && corrente(); } };
}
