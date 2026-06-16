'use strict';

import { state } from './state.js';
import { $ } from './utils.js';
import { initUml, loadUml } from './uml.js';
import { initConnection } from './connection.js';
import { initDbTree } from './dbtree.js';
import { initSchemaOps } from './schema-ops.js';
import { initGrid } from './grid.js';
import { initInlineEdit } from './inlineEdit.js';
import { initInsert } from './insert.js';
import { initDetails, loadDetails } from './details.js';
import { initLive } from './live.js';

export function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-data').classList.toggle('hidden', view !== 'data');
  $('#view-details').classList.toggle('hidden', view !== 'details');
  $('#view-uml').classList.toggle('hidden', view !== 'uml');
  if (view === 'details') loadDetails();
  if (view === 'uml') loadUml(false);
}

document.querySelectorAll('.view-tab').forEach((tab) =>
  tab.addEventListener('click', () => setView(tab.dataset.view))
);

initUml();
initConnection();
initDbTree();
initSchemaOps();
initGrid();
initInlineEdit();
initInsert();
initDetails();
initLive();
