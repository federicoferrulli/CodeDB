'use strict';

/**
 * Che cosa rende un piano un CONTRATTO, ed è la stessa cosa per l'import e per
 * l'export: la forma canonica su cui si calcola l'impronta, l'impronta stessa,
 * il congelamento e il controllo che anteprima ed esecuzione stiano guardando
 * lo stesso piano.
 *
 * Vivevano dentro `importPlan.js`. L'export ne ha bisogno delle stesse quattro,
 * e riscriverle avrebbe significato due definizioni di «canonico» che possono
 * divergere senza che nulla lo segnali — cioè due piani che si dichiarano
 * uguali con impronte diverse, o peggio diversi con la stessa impronta.
 */

const crypto = require('crypto');

/** Ordina le chiavi a ogni livello: l'impronta non deve dipendere dall'ordine. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  const hash = crypto.createHash('sha256');
  let buffer = '';
  const write = text => {
    buffer += text;
    if (buffer.length >= 65536) { hash.update(buffer); buffer = ''; }
  };
  // Stessa serializzazione canonica, senza duplicare tutti i documenti e poi
  // materializzare una seconda stringa grande quanto l'intero database.
  function visit(item) {
    if (Array.isArray(item)) {
      write('[');
      for (let i = 0; i < item.length; i++) { if (i) write(','); visit(item[i] === undefined ? null : item[i]); }
      write(']');
    } else if (item && typeof item === 'object') {
      write('{');
      let first = true;
      // Object.keys riordina le chiavi intere come JSON.stringify(canonical).
      const keys = Object.keys(Object.fromEntries(Object.keys(item).sort().map(k => [k, null])));
      for (const key of keys) {
        if (item[key] === undefined) continue;
        if (!first) write(','); first = false;
        write(JSON.stringify(key) + ':'); visit(item[key]);
      }
      write('}');
    } else write(JSON.stringify(item));
  }
  visit(value);
  if (buffer) hash.update(buffer);
  return hash.digest('hex');
}

function congela(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) congela(child);
  return Object.freeze(value);
}

/** Il corpo su cui si calcola l'impronta: tutto tranne l'impronta stessa. */
function contenutoImpronta(plan) {
  const { fingerprint: _fingerprint, ...rest } = plan;
  return rest;
}

/** Compone corpo e impronta e congela: la sola via per costruire un piano. */
function sigilla(body) {
  return congela({ ...body, fingerprint: fingerprint(body) });
}

function verificaImpronta(plan) {
  if (!plan || plan.fingerprint !== fingerprint(contenutoImpronta(plan))) {
    throw new Error('Il piano non coincide con la sua impronta: anteprima ed esecuzione sono divergenti.');
  }
}

module.exports = { canonical, fingerprint, congela, contenutoImpronta, sigilla, verificaImpronta };
