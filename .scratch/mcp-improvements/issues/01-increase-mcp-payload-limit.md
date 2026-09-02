# 01: Increase MCP HTTP payload limit for large artifacts

**What to build:** Consente agli agenti AI di inviare file e payload di dimensioni realistiche (superiori ai 5MB) tramite il tool `import_database_artifact`, senza incappare in errori HTTP 413 Payload Too Large. Questo rende possibile il ripristino o l'importazione di database completi in una sola chiamata.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [X] Modificare la configurazione del gateway in modo che l'endpoint `/mcp` accetti payload JSON di dimensioni nettamente superiori (es. 50MB o più).
- [X] Testare l'invio via MCP di un finto file `.codedb.json` da ~10MB, verificando che il server passi correttamente allo step di anteprima (generazione del `confirm_token`) invece di restituire 413.

