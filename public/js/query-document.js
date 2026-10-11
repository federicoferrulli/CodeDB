import { activeTab } from './tabs.js';

// L'identità è il documento, non la connessione: due schede possono eseguire insieme.
export function queryDocument(tab = activeTab(), collId = tab?.state.activeCollId) {
  if (!tab) return null;
  const owner = tab.state.collTabs.find(c => c.id === collId) || tab.state;
  return owner.snapQuery ||= { code: '', engine: 'auto', runId: null };
}

export function documentoVisibile(tab, collId) {
  return activeTab() === tab && tab.state.activeCollId === collId;
}

export function copiaQuery(q) {
  if (!q) return null;
  return { ...q, runId: null, scriptRunId: null, file: null,
    metrics: q.metrics?.[0] === 'running' ? ['idle'] : q.metrics,
    order: q.order?.map(item => ({ ...item })), widths: new Map(q.widths || []), manualWidths: new Set(q.manualWidths || []),
    chartCfg: q.chartCfg ? structuredClone(q.chartCfg) : null,
  };
}
