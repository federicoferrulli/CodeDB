# Contratto di licenza con l'utente finale (EULA)

Versione 1.0 — 9 agosto 2026

Il presente accordo (**End User License Agreement**) regola l'installazione e
l'uso dell'applicazione CodeDB — versione desktop, versione web (server locale,
container o esposta in rete) e relativo codice sorgente — insieme alla licenza
open source **GNU Affero General Public License v3.0 only (AGPL-3.0-only)**, il
cui testo integrale è nel file `LICENSE.md`. Installando o usando il software
l'utente accetta questi termini.

La **Manleva** (file `MANLEVA.md`, riportata insieme al presente accordo) ne
costituisce parte integrante.

Titolare: Federico Ferrulli. Contatti: `info@codedb.org`.
Repository ufficiale: `https://github.com/federicoferrulli/gui-mongodb`.

## 1. Concessione di licenza

Nei termini della licenza AGPL-3.0 e del presente accordo, all'utente è
concessa una licenza **non esclusiva, mondiale e revocabile** per:

- installare ed eseguire CodeDB su dispositivi personali o postazioni aziendali;
- ispezionare, compilare e modificare il codice sorgente pubblicato nel
  repository ufficiale indicato sopra;
- ridistribuire copie o versioni modificate alle condizioni della AGPL-3.0,
  mantenendo il codice sorgente accessibile — **anche quando il software è
  offerto soltanto attraverso la rete** (art. 13 della licenza).

L'attribuzione e le note di copyright vanno conservate.

## 2. Gateway MCP e componenti modulari

Il Gateway MCP (Model Context Protocol) e gli strumenti per agenti AI sono
progettati per funzionare in modo modulare: l'uso delle API pubbliche e degli
SDK di integrazione **non estende gli obblighi copyleft** alle applicazioni
esterne dell'utente né ai suoi modelli di intelligenza artificiale.

## 3. Licenze commerciali (dual licensing)

Le organizzazioni che intendono integrare componenti di CodeDB in prodotti
proprietari senza sottostare agli obblighi copyleft della AGPL-3.0 possono
richiedere una **licenza commerciale o enterprise** dedicata, con eventuali
contratti di supporto, scrivendo a `info@codedb.org`.

## 4. Responsabilità sui dati e sulle operazioni

CodeDB è uno strumento client per la gestione visiva e assistita da AI di
database (MongoDB, MySQL, PostgreSQL). L'utente riconosce e accetta che:

- query, script, cancellazioni, aggiornamenti e migrazioni di schema eseguiti
  tramite l'interfaccia o tramite agenti AI collegati al Gateway MCP avvengono
  sotto la **sua esclusiva responsabilità**;
- è suo onere disporre di copie di sicurezza aggiornate prima di eseguire
  operazioni di modifica su ambienti di produzione;
- resta a suo carico il rispetto delle norme applicabili ai dati trattati,
  comprese quelle sulla protezione dei dati personali.

## 5. Assenza di garanzia e limitazione di responsabilità

Valgono integralmente, come parte del presente accordo, l'esclusione di
garanzia e la limitazione di responsabilità della **Manleva** (`MANLEVA.md`):
il software è fornito "così com'è", senza garanzie di alcun tipo, e il titolare
non risponde dei danni derivanti dal suo uso o dall'impossibilità di usarlo.

## 6. Obbligo di manleva e difesa

L'utente si impegna a difendere, indennizzare e tenere indenne il titolare da
qualsiasi pretesa, contestazione, azione, perdita, responsabilità, costo o
spesa — comprese le ragionevoli spese legali — derivanti da:

- la violazione del presente accordo o dei termini della licenza AGPL-3.0;
- l'uso improprio delle credenziali di accesso ai propri database;
- le operazioni eseguite tramite CodeDB o tramite agenti AI collegati al
  Gateway MCP, comprese quelle che ledano diritti di terzi.

## 7. Marchi e identità del prodotto

Il nome **CodeDB**, il logo e i segni distintivi del prodotto sono marchi del
titolare. La licenza AGPL-3.0 concede diritti sul **codice** — interfaccia,
fogli di stile e risorse grafiche compresi, che sono parte del codice
distribuito — ma **non** sull'uso dei marchi: una versione modificata o
ridistribuita non può presentarsi come CodeDB ufficiale, usarne il nome e il
logo per accreditarsi come tale, né adottare un aspetto tale da ingenerare
confusione sull'origine del prodotto.

## 8. Durata, legge applicabile e foro

La licenza resta valida finché l'utente rispetta questi termini; la violazione
degli obblighi della AGPL-3.0 ne comporta la cessazione automatica, secondo
quanto previsto dalla licenza stessa.

L'accordo è regolato dalla **legge italiana**. Per le controversie è competente
il foro del luogo di residenza del titolare, salvo il foro inderogabile del
consumatore quando l'utente agisce per scopi estranei alla propria attività
professionale.
