'use strict';
// Token interni non serializzabili: il client non può fornire una sessione o
// sostituire la verifica dei permessi delle istruzioni di una procedura.
module.exports = { SESSION: Symbol('sessione SQL'), AUTHORIZE: Symbol('autorizza istruzione SQL'), ACCESS: Symbol('autorizza vincoli SQL'), DEFAULT: Symbol('valore predefinito SQL'), SCHEMAS: Symbol('schemi della migrazione SQL'), MIGRATION: Symbol('migrazione SQL interna'), ROUTINE: Symbol('corpo della routine interna'), FLOW: Symbol('limiti delle routine annidate') };
