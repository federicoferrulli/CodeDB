# 04: Introduce execute_ddl tool for explicit schema operations

**What to build:** Fornisce agli agenti AI un tool dedicato (`execute_ddl`) per l'esecuzione di comandi DDL (Data Definition Language) sui database relazionali, come `CREATE TABLE`, `CREATE DATABASE`, `ALTER TABLE` o `DROP`. Attualmente il tool `execute_write` blocca ferocemente il DDL, costringendo a workaround fragili (come usare import_database_artifact con documenti vuoti).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [X] Implementare un nuovo tool MCP `execute_ddl` che utilizzi lo stesso meccanismo in due passaggi (anteprima + `confirm_token`) di `execute_write`.
- [X] Il tool accetterà un parametro `sql` contenente query esclusive di tipo DDL.
- [X] Verificare le "capability" dell'utente in ambito RBAC (per assicurarsi che abbia il ruolo `ddl` o `manage` per compiere tali alterazioni strutturali).
- [X] Registrare appropriatamente l'evento distruttivo negli audit log.

