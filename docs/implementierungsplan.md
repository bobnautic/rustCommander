# Implementierungsplan zur Feature-Analyse

*Stand: 2. November 2026. Grundlage ist [`feature-analyse.md`](feature-analyse.md) (Fable,
Commit `5e68f3d`). Wie die Analyse ist dieses Dokument nicht Teil des mdBook.*

Der Plan folgt der Reihenfolge aus Abschnitt 5 der Analyse: Version 0.2 macht die App
robust und schützt Daten, 0.3 bringt Desktop-Reife und Alltagskomfort, 0.4 öffnet den
Web-Modus für Teams und Automatisierung. Jede Version ist in Pakete geschnitten, die
einzeln als Pull Request gemergt werden können. Abhängigkeiten stehen beim Paket.

**Legende:** ✅ umgesetzt (in diesem PR) · 🟡 teilweise · ⬜ geplant.
Aufwand wie in der Analyse: S = Stunden, M = ein bis wenige Tage, L = eine Woche oder mehr.

---

## 1. Version 0.2 – Robustheit und Datensicherheit (dieser PR)

### 1.1 ✅ Persistente Job-Queue und Session-Wiederherstellung (Empfehlung 1)

**Umsetzung**

- **Journal pro Job** (`rc-core/src/jobs.rs`, `JobJournal`): fertige Elemente (`done`) und
  Elemente in Arbeit mit Schreibpfad und Zielpfad (`active`). `TransferTask`,
  `DeleteTask` und `SyncTask` führen es; Schlüssel ist `Session + Pfad`.
- **Wiederaufnahme**: Ein wiederhergestellter Job überspringt fertige Dateien und setzt
  eine halb geschriebene Datei an ihrem Ende fort (auch `.filepart`), statt nach ihr zu
  fragen. Dateien, die vor dem Neustart nicht angefasst wurden, folgen dem ursprünglichen
  Überschreibmodus. Damit gibt es keine Fehlbedienung durch ein pauschales `Resume`.
- **`JobQueue::submit_with`**: feste Job-ID, Startzeit, Journal und Pausenzustand.
  Pausierte Jobs belegen keinen Slot mehr.
- **`rc-api/src/persist.rs`**: `jobs.json` (alle unfertigen Jobs mit `JobDescriptor` –
  Transfer, Löschen, Sync – und Journal), `sessions.json` (offene Verbindungen: Site-ID
  oder Site ohne Geheimnisse, tatsächlich genutztes Protokoll). Gespeichert wird bei
  Änderungen höchstens alle 2 s (große Journale alle 15 s) und beim Beenden; danach wird
  eingefroren, damit das Schließen der Verbindungen laufende Jobs nicht als „fehlgeschlagen“
  speichert.
- **Start**: Jobs kommen mit ihrer ID zurück (laufende laufen weiter, pausierte bleiben
  pausiert), Sessions werden unter ihrer alten ID neu verbunden. Panels kehren zu einer
  wiederhergestellten Session zurück, solange der Benutzer nicht woanders hin navigiert hat.
  Ein Job wartet bei gesperrtem Tresor, bis er entsperrt ist; nach dem Entsperren werden
  ausstehende Sessions verbunden.
- **Einstellungen**: `restoreSessions`, `resumeJobs` (Voreinstellung jeweils an).
- **Beifang**: `watch::Sender::send` verwarf „Pause“/„Fortsetzen“, solange der Job-Task
  noch nicht lief; jetzt `send_replace`.

**Tests**: Kern (übersprungene und fortgesetzte Dateien, pausierte Jobs ohne Slot),
`rc-api` (Neustart mit wiederhergestelltem Job), End-to-End gegen OpenSSH
(`rc-api/tests/restore.rs`: Session unter alter ID, Upload läuft weiter).

**Offen für später**: Watches (Keep up to date) und Archiv-Jobs werden nicht persistiert
(siehe 2.6); ein Transferprotokoll/Historie (2.2 der Analyse) baut auf `jobs.json` auf.

### 1.2 ✅ Papierkorb und Undo (Empfehlung 2)

- `DeleteTask.trash`: lokale Dateien der Desktop-App gehen über das Crate `trash` in den
  Systempapierkorb. F8/Entf = Papierkorb, Umschalt+F8/Umschalt+Entf = endgültig.
  Der Bestätigungsdialog nennt, was passiert. Einstellung `useTrash`. Im Headless-Server
  und auf entfernten Systemen wird direkt gelöscht.
- Einstufiges **Undo** (Strg+Z, *Dateien → Rückgängig*) für Umbenennen und Verschieben
  innerhalb einer Session (`ui/src/actions/undo.ts`). Ein Verschieben wird erst nach
  Abschluss des Jobs rückgängig machbar; zurückverschoben wird nur, was noch unverändert
  am Ziel liegt.

**Offen**: Wiederherstellen aus dem Papierkorb in der App (das Crate kann es nur unter
Linux/Windows) – Aufwand S, Priorität niedrig.

### 1.3 ✅ Serverseitige Abkürzungen über `exec` (Empfehlung 3, Abschnitt 3.1)

`rc-core/src/remote.rs`, aktiv für SFTP und SCP:

| Operation | Befehl | Rückfall |
|---|---|---|
| Rekursives Löschen | `rm -rf --` (ohne vorheriges Auflisten) | Eintrag für Eintrag |
| Rekursive Rechte/Besitzer | `find … -exec chmod/chown/chgrp {} +` | `set_permissions` pro Eintrag |
| Ordnergröße | `find -printf '%y %s' \| awk` | `ops::walk` |
| Suche | `find -printf` für den Baum, `grep -l -F` für Inhalte (in Paketen ≤ 48 KiB) | Walk + Download |

Schutzmaßnahmen: Shell und SFTP müssen dasselbe Home sehen (`pwd` = SFTP-Home, sonst
z. B. chroot oder virtuelles SFTP), GNU find wird per Probe erkannt, nie auf `/` oder
relative Pfade, Kontonamen werden geprüft, alles wird gequotet. Jeder Fehlschlag fällt auf
den bisherigen Weg zurück, der Fehler pro Datei meldet.

**Tests**: Befehlsbau und Parser (Unit), gleiche Ergebnisse wie der generische Weg gegen
OpenSSH über SFTP und SCP (`rc-core/tests/ssh.rs`).

**Offen**: BSD/macOS-Server (kein `find -printf`) nutzen weiter den generischen Weg; ein
`stat -f`-Zweig wäre S.

### 1.4 ✅ Prüfsummen und Zeitstempel auf Objektspeichern (Empfehlung 4, Abschnitt 3.2)

- `CloudVfs::checksum(Md5)` aus den Metadaten: rclone-`md5chksum`, `Content-MD5`
  (Azure, GCS `md5Hash`), bei S3 ein ETag ohne `-N`-Suffix.
- `Capabilities.checksumAlgos`: welche Algorithmen ein Server selbst rechnet.
  `ops::preferred_algo` wählt den stärksten gemeinsamen (lokal zählt als „alle“), genutzt
  von *Überschreiben bei anderem Inhalt*, *Prüfen nach Übertragung* und Sync nach
  Prüfsumme. Ein Unterschied nach einer Übertragung wird mit SHA-256 gegengeprüft (ETag
  bei SSE-KMS ist kein MD5).
- `WriteOptions.modified`: Uploads speichern die Quell-mtime als Benutzer-Metadatum
  `mtime` (rclone-kompatibel: S3 Sekunden, Azure/GCS RFC 3339); `stat` liest sie zurück.
  Der Sync-Vergleich holt sie für Dateien, die auf beiden Seiten existieren (16 parallele
  `HEAD`), damit *Update*/*Both* nicht an Upload-Zeiten scheitern.

**Offen**: Fortsetzbare Multipart-Uploads (Upload-ID merken) – M, eigenes Paket in 0.3;
Fingerprint-Dialog: Voreinstellung des Algorithmus nach `checksumAlgos` – S.

### 1.5 ✅ Sync-Konflikte auflösen (Empfehlung 5, erster Teil)

- `SyncAction.resolution` mit `leftWins`, `rightWins`, `keepBoth`, `skip`; `sync.execute`
  nimmt `resolutions` entgegen. *Beide behalten* benennt die rechte Version in
  `name (1).ext` um und kopiert jede Version auf die andere Seite (über das Journal
  wiederaufnehmbar). Bei Datei-gegen-Ordner-Konflikten ersetzt der Gewinner den Eintrag.
- Checkliste: Auswahl pro Konfliktzeile, „Alle Konflikte auflösen …“ (auch *Neuere
  Version gewinnt*), Diff-Knopf in der Zeile; ungelöste Konflikte werden nicht ausgeführt.
- Scripting: `synchronize … -conflict=skip|local|remote|both|fail`.
- Prüfsummen-Kandidaten werden parallel (4) verglichen.
- **Fehler behoben**: Bei Datei-gegen-Ordner-Konflikten erzeugte der Vergleich zusätzlich
  Aktionen für den Inhalt des Ordners.

### 1.6 ✅ Qualität, CI und Abhängigkeiten (Abschnitt 4)

- Playwright-Smoke-Test läuft in der CI (Chromium, Screenshots als Artefakt); neue
  Schritte für Papierkorb/Undo und Konfliktauflösung.
- Neuer CI-Job **Dependency audit**: `cargo audit` und `npm audit --omit=dev`.
- `.github/dependabot.yml` für Cargo, npm (UI und Wurzel) und GitHub Actions.
- **Schwachstellen**: `zip` 2.6 → 9.2 (RUSTSEC-2026-0367/0368/0369/0429, darunter eine
  kritische); beim Entpacken werden außerdem keine setuid/setgid-Bits mehr gesetzt.
  `rsa` (RUSTSEC-2023-0071, Marvin) hat keinen Fix und kommt über russh; begründete
  Ausnahme in `.cargo/audit.toml`. `npm audit` meldet keine Funde.
- Unit-Test für die Übersetzungen (gleiche Schlüssel, Platzhalter, Pluralformen).

### 1.7 ✅ Kleinere Punkte aus der Analyse, die mit 0.2 erledigt sind

- **Queue-Steuerung** (2.2): *Alle anhalten/fortsetzen/abbrechen*, Geschwindigkeitslimit
  zur Laufzeit (`jobs.setSpeedLimit`, `RateLimiter::set` war schon da).
- **Nur Fehlgeschlagene wiederholen** (2.2): `jobs.retry` mit `onlyMissing` nutzt das
  Journal.
- **Konflikte in Scripts** (2.9): siehe 1.5.

### 1.8 ⬜ Rest von 0.2

| Paket | Inhalt | Aufwand |
|---|---|---|
| Protokoll-Integrationstests in der CI | Job mit Docker-Services (OpenSSH, pyftpdlib, WsgiDAV, moto, Azurite, fake-gcs-server); die Tests lesen schon `RC_TEST_*`-Variablen, die Server-Skripte liegen in `crates/rc-core/tests/servers/`. Lokal wurde dieser PR gegen OpenSSH getestet. | M |
| Zeittoleranz pro Protokoll | Vorgabe 60 s bei FTP ohne MLSD, Hinweis im Sync-Dialog; `sync.defaults` mit Sessions | S |

---

## 2. Version 0.3 – Desktop-Reife und Alltag

Reihenfolge nach Nutzen; Pakete sind unabhängig, sofern nicht anders vermerkt.

| # | Paket | Umsetzung in Kürze | Aufwand |
|---|---|---|---|
| 2.1 | **Auto-Update** | `tauri-plugin-updater`, signierte `latest.json` als Release-Asset aus `release.yml` (Signierschlüssel als Secret), Prüfung beim Start und unter *Hilfe*, Hinweis-Toast mit „Jetzt neu starten“. | M |
| 2.2 | **Fensterzustand** | `tauri-plugin-window-state` (Größe, Position, maximiert). | S |
| 2.3 | **Benachrichtigungen, Tray** | `tauri-plugin-notification` bei Jobende und Konfliktfrage, wenn das Fenster nicht fokussiert ist; Tray-Symbol mit laufenden Jobs/Watches. Hängt an den Job-Events in `boot.ts`. | S–M |
| 2.4 | **Code-Signing** | Apple Developer ID + Notarisierung, Windows-Signaturzertifikat; Secrets in `release.yml`. Kosten klären. | S |
| 2.5 | **Dateizwischenablage** | App-interne Zwischenablage (Strg+C/X/V) mit Session + Pfaden; Einfügen startet einen Transfer (Ausschneiden = Verschieben, Undo über 1.2). | S |
| 2.6 | **Log-Viewer mit Follow** | `fs.readRange` (Offset/Länge) und `fs.follow` (Polling der Größe, Event `file.appended`); Viewer mit Folgen, Sprung ans Ende, Suche; ersetzt die 8-MiB-Grenze für Text. | M |
| 2.7 | **Mehrfach-Umbenennen** | Dialog mit Muster (`[N]`, `[E]`, Zähler, Datum), RegEx-Suchen/Ersetzen, Vorschau, Ausführung als Job aus `fs.rename`-Schritten; Undo als Gruppe. | M |
| 2.8 | **Verzeichnis-Tabs pro Panel** | `panels.ts`: Liste von Locations pro Seite, Tab-Leiste über der Tabelle, Strg+Umschalt+T (Strg+T bleibt Terminal), Persistenz in `localStorage`. | M |
| 2.9 | **Sync-Profile und Zeitplan** | `sync_profiles.json` (Parameter + Optionen + Konfliktregel), Menü „Letzte Synchronisation wiederholen“; Scheduler im Backend (Cron-Ausdruck oder „beim Verbinden“), Jobs laufen über die persistente Queue (1.1). | S–M + M |
| 2.10 | **Letzte Verbindungen** | `sessions.json` (1.1) um eine Historie mit Zähler erweitern; Liste im Site Manager und im Startbildschirm. | S |
| 2.11 | **Vault-Auto-Lock, OS-Schlüsselbund** | Timeout-Sperre (Einstellung), Sperre bei Bildschirmsperre (Tauri-Event); Crate `keyring` als Alternative zu `vault.key`. | S + S–M |
| 2.12 | **Fortsetzbare Multipart-Uploads** | Upload-ID und Teile-ETags im Journal (1.1), `ListParts` beim Fortsetzen. | M |
| 2.13 | **Watches persistieren und erweitern** | `watches.json`, Pausieren, Polling-Watch remote → lokal über `ops::walk`. | M |
| 2.14 | **Remote Explorer für alle Protokolle**, **Terminal-Addons** (Suche, Links, Zwischenablage), **Pfadleiste mit Vervollständigung** | überwiegend UI-Arbeit, Code aus `OpenFileDialog.tsx` wiederverwenden. | M, S, S |

## 3. Version 0.4 – Server und Team

| # | Paket | Umsetzung in Kürze | Aufwand |
|---|---|---|---|
| 3.1 | **Mehrbenutzer und Rollen** | `users.json` (Argon2), Rollen *Admin*, *Benutzer*, *Nur-Lesen*; `Origin::Web` trägt den Benutzer, `dispatch` prüft Methoden gegen die Rolle; Sessions und Jobs pro Benutzer oder geteilt; Audit-Log. | L |
| 3.2 | **Zweiter Faktor** | TOTP (`totp-rs`) beim Login, Wiederherstellungscodes; später OIDC. | M |
| 3.3 | **API-Tokens** | Benannte, widerrufbare Tokens mit Rolle und Ablaufdatum; Verwaltung in den Einstellungen und per `rcmd token`. | S–M |
| 3.4 | **Reverse-Proxy** | `--trusted-proxy <cidr>` wertet `X-Forwarded-For` für Drosselung und Log aus. | S |
| 3.5 | **TLS-Optionen** | `--cert/--key`; ACME später. | S / M |
| 3.6 | **Web-Sessions verwalten**, **IP-Allowlist**, konfigurierbare Drosselung | Übersicht aktiver Cookies, „Alle abmelden“. | S |
| 3.7 | **Persistentes Log, Transferhistorie** | Rotierende Logdatei; abgeschlossene Jobs aus der Queue in `history.jsonl`, Export. | S |
| 3.8 | **`rcmd`-Einzelbefehle, `--json`, Shell-Completion, Site-Verwaltung per CLI** | `rcmd get/put/sync/ls <url>` über dieselbe Engine wie Scripts; `clap_complete`. | S–M |
| 3.9 | **Script-Variablen**, **`keepuptodate` als Dienst** | `%1%`/Umgebungsvariablen; Watches aus 2.13 in `rcmd serve`. | S, S–M |
| 3.10 | **PWA-Manifest** | `manifest.webmanifest`, Icons; kein Service Worker nötig. | S |

## 4. Später

SMB/CIFS (L, `pavao` oder eigener Client), Rsync-Delta über `exec` (L), Consumer-Clouds
über OpenDAL mit OAuth (M–L), SSH `-R`/Agent-Forwarding/`ProxyCommand`/Host-Zertifikate,
WebDAV Digest/Bearer, S3-Presigned-Links und Metadaten-Editor, Quick-View-Panel und
weitere Vorschauen, Öffnen mit …, konfigurierbare Tastenkürzel, weitere Sprachen,
portabler Modus, Drag aus der App, Suche mit RegEx und Aktionen auf Ergebnissen,
Editor-Extras (Backup vor dem Speichern, Wortvervollständigung, Speichern mit sudo).

## 5. Vorgehen pro Paket

1. Backend zuerst (Kern → `rc-api` → Typen in `ui/src/api/types.ts`), dann UI und Mock
   (`ui/src/api/mock.ts`), damit Smoke-Test und Demo-Modus mitwachsen.
2. Tests: Unit-Tests im Kern, Vertragstest in `rc-api/tests/dispatch.rs`, ein Schritt im
   Smoke-Test für sichtbare Funktionen, Integrationstest gegen echte Server für
   Protokollarbeit.
3. Doku im mdBook (`docs/src`), Übersetzungen Deutsch und Englisch (der Unit-Test prüft die
   Parität).
