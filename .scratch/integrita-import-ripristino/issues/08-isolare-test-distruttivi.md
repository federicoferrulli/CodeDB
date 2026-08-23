# 08: Isolare i test distruttivi dai database locali

Status: ready-for-agent
Type: task
Blocked by: nessuno

Impedire che un E2E cancelli un database o schema preesistente soltanto perché ne condivide
il nome fisso. L'harness deve possedere e poter dimostrare ogni bersaglio distruttivo.

- [ ] Database e schemi ricevono un marcatore casuale per esecuzione
- [ ] Un flag E2E esplicito è obbligatorio prima del primo comando distruttivo
- [ ] Ogni target viene verificato contro il marcatore della fixture corrente
- [ ] Il cleanup usa soltanto il registro dei target creati dalla stessa fixture
- [ ] Nessun test distruttivo usa più un nome fisso come unica barriera
- [ ] Un test prova che un nome storico omonimo ma non registrato viene rifiutato
- [ ] La sensibilità viene dimostrata togliendo il controllo di proprietà del target

