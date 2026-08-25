# 08: Isolare i test distruttivi dai database locali

Status: resolved
Type: task
Blocked by: nessuno

Impedire che un E2E cancelli un database o schema preesistente soltanto perché ne condivide
il nome fisso. L'harness deve possedere e poter dimostrare ogni bersaglio distruttivo.

- [x] Database e schemi ricevono un marcatore casuale per esecuzione
- [x] Un flag E2E esplicito è obbligatorio prima del primo comando distruttivo
- [x] Ogni target viene verificato contro il marcatore della fixture corrente
- [x] Il cleanup usa soltanto il registro dei target creati dalla stessa fixture
- [x] Nessun test distruttivo usa più un nome fisso come unica barriera
- [x] Un test prova che un nome storico omonimo ma non registrato viene rifiutato
- [x] La sensibilità viene dimostrata togliendo il controllo di proprietà del target

## Risposta

L'harness genera un marcatore casuale a 12 cifre esadecimali, registra ogni target e
rifiuta drop/cleanup senza `destructive: true`, senza appartenenza al registro o con un
marcatore diverso. Tutti gli E2E che eliminano database o schemi usano il registro. La
controprova senza controllo di proprietà ha accettato il nome storico e reso rosso il
test dedicato.
