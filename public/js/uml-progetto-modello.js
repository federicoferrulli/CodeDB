// La bozza si salva nel documento; non contiene SQL né token di esecuzione.
export function leggiOperazioni(raw) {
  if (!Array.isArray(raw)) return [];
  const kinds = ['createTable', 'addColumn', 'alterColumn', 'dropColumn', 'renameTable', 'dropTable', 'addPrimaryKey', 'replacePrimaryKey', 'dropPrimaryKey', 'addForeignKey', 'replaceForeignKey', 'dropForeignKey'];
  const str = (v, n = 2000) => typeof v === 'string' ? v.slice(0, n) : '';
  const col = (c = {}) => ({ name: str(c?.name, 63), type: str(c?.type, 200), default: str(c?.default),
    nullable: c?.nullable !== false, autoIncrement: c?.autoIncrement === true, primaryKey: c?.primaryKey === true });
  return raw.slice(0, 100).filter((o) => o && kinds.includes(o.kind)).map((o) => ({
    id: str(o.id, 64) || globalThis.crypto.randomUUID(),
    kind: o.kind, table: str(o.table, 63), name: str(o.name, 63), oldName: str(o.oldName, 63),
    column: col(o.column), columns: Array.isArray(o.columns) ? o.columns.slice(0, 200).map((c) => o.kind === 'createTable' ? col(c) : str(c, 63)) : [],
    target: str(o.target, 63), references: Array.isArray(o.references) ? o.references.slice(0, 64).map((s) => str(s, 63)) : [],
    onDelete: str(o.onDelete, 20), onUpdate: str(o.onUpdate, 20),
    x: Number.isFinite(o.x) ? Math.max(-200000, Math.min(200000, o.x)) : 80,
    y: Number.isFinite(o.y) ? Math.max(-200000, Math.min(200000, o.y)) : 80,
  }));
}

export function campiProgettati(fields, table, ops) {
  let result = fields.map((f) => ({ ...f }));
  const daColonna = c => ({ name: c.name, types: [c.type], nullable: c.primaryKey || c.autoIncrement ? false : c.nullable,
    default: c.default, autoIncrement: c.autoIncrement, key: c.primaryKey ? 'PRI' : '' });
  for (const op of ops) {
    if (op.table !== table) continue;
    if (op.kind === 'renameTable') table = op.name;
    const c = op.column;
    const field = c && daColonna(c);
    if (op.kind === 'createTable') result = op.columns.map(daColonna);
    if (op.kind === 'addColumn') result.push(field);
    if (op.kind === 'alterColumn') result = result.map((f) => f.name === op.oldName ? { ...f, ...field, key: f.key, autoIncrement: f.autoIncrement } : f);
    if (op.kind === 'dropColumn') result = result.filter((f) => f.name !== op.name);
    if (op.kind === 'dropTable') result = [];
    if (['addPrimaryKey', 'replacePrimaryKey', 'dropPrimaryKey'].includes(op.kind)) {
      result = result.map((f) => ({ ...f, pk: op.kind !== 'dropPrimaryKey' && op.columns.includes(f.name),
        key: op.kind !== 'dropPrimaryKey' && op.columns.includes(f.name) ? 'PRI' : (f.key === 'PRI' ? '' : f.key) }));
    }
  }
  return result;
}

// L'origine resta quella del database; il nome e i passi seguono la bozza,
// anche dopo più rinomine o dopo aver ricreato una tabella eliminata.
export function tabelleProgettate(names, ops) {
  const tables = new Map(names.map(name => [name, { origine: name, passi: [] }]));
  for (const op of ops) {
    if (op.kind === 'createTable') tables.set(op.table, { origine: null, passi: [op] });
    else if (op.kind === 'dropTable') tables.delete(op.table);
    else if (op.kind === 'renameTable') {
      const state = tables.get(op.table);
      if (state) { tables.delete(op.table); tables.set(op.name, state); }
    } else tables.get(op.table)?.passi.push(op);
  }
  return tables;
}

export function metadatiProgettati(base, table, state, ops, db) {
  let relazioni = (base.relazioni || []).map(r => ({ ...r, coppie: (r.coppie || []).map(p => ({ ...p })) }));
  for (const op of ops) {
    if (state.passi.includes(op)) {
      if (['replaceForeignKey', 'dropForeignKey'].includes(op.kind)) relazioni = relazioni.filter(r => r.nome !== (op.oldName || op.name));
      if (['addForeignKey', 'replaceForeignKey'].includes(op.kind)) relazioni.push({ nome: op.name, db, tabella: op.target,
        coppie: op.columns.map((campo, i) => ({ campo, colonna: op.references[i] })),
        onDelete: op.onDelete || 'NO ACTION', onUpdate: op.onUpdate || 'NO ACTION' });
      if (op.kind === 'alterColumn') for (const r of relazioni) for (const p of r.coppie) {
        if (p.campo === op.oldName) p.campo = op.column.name;
      }
    }
    for (const r of relazioni) if ((!r.db || r.db === db) && r.tabella === op.table) {
      if (op.kind === 'renameTable') r.tabella = op.name;
      if (op.kind === 'alterColumn') for (const p of r.coppie) if (p.colonna === op.oldName) p.colonna = op.column.name;
    }
  }
  return { ...base, relazioni, fields: campiProgettati(base.fields, table, state.passi.map(op => ({ ...op, table }))) };
}
