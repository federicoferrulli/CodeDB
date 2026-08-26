# 14: Rendere la rinomina sicura rispetto alle scritture concorrenti

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

**What to build:** La rinomina deve includere o fermare le scritture concorrenti e non
eliminare l'origine finché lo stato corrente della destinazione non soddisfa il piano.

- [ ] La rinomina segue il contratto delle operazioni lunghe dell'ADR-0001
- [ ] Il piano dichiara la garanzia disponibile per ciascun motore
- [ ] Una scrittura tra copia e promozione viene inclusa oppure impedisce il completamento
- [ ] La verifica finale confronta lo stato corrente e precede sempre il drop dell'origine
- [ ] Un esito non completato conserva una copia sana e indica l'intervento necessario
- [ ] E2E sui tre motori inseriscono una scrittura concorrente nel punto controllato
- [ ] La controprova che verifica soltanto la copia iniziale rende rosso il test

