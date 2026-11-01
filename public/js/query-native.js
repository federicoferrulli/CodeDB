import { activeTab } from './tabs.js';
import { $ } from './utils.js';

export function renderNativeTargets() {
  const engine = $('#query-target-engine');
  for (const option of engine.options) {
    const estraneo = ['mysql', 'postgresql', 'mongodb'].includes(option.value) && option.value !== activeTab()?.state.dbType;
    option.disabled = estraneo;
    option.hidden = estraneo;
  }
  if (engine.selectedOptions[0]?.disabled) engine.value = 'auto';
}

export function initNativeTargets() {
  $('#query-target-btn')?.addEventListener('click', renderNativeTargets);
}
