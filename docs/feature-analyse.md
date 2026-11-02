# Feature-Analyse: Was fehlt, was besser werden sollte

*Stand: 2. November 2026, Version 0.1.0 (Commit `570318e`). Grundlage: vollständige Durchsicht
von `crates/`, `src-tauri/`, `ui/src/`, der Dokumentation unter `docs/` und der CI-Workflows.
Offene GitHub-Issues gibt es keine; alle sieben bisherigen Pull Requests sind gemergt.*

Dieses Dokument ist nicht Teil des mdBook (nicht in `SUMMARY.md` verlinkt). Es ist eine
Arbeitsgrundlage für die Planung der nächsten Versionen.

---

## 1. Kurzfazit

Rust Commander ist für ein Projekt, das vier Tage alt ist, erstaunlich vollständig: neun
Protokolle hinter einer sauberen `Vfs`-Abstraktion, eine Job-Queue mit Pause/Resume/Konflikten,
Synchronisation mit Checkliste, Fingerprint-Vergleich mit serverseitigen Prüfsummen, ein
Editor mit Linting und Formatierung, Terminal, Tunnel, Web-Modus mit CSRF-Schutz und
Login-Drosselung, LAN-Discovery, Scripting und eine Release-Pipeline für drei Plattformen.
Die Codequalität ist hoch (Tests auf Kern- und API-Ebene, saubere Fehlertypen, Capabilities
pro Protokoll).

Die Lücken liegen weniger in der Breite als in drei Bereichen:

1. **Robustheit über Neustarts hinweg**: Die Job-Queue, die offenen Sessions, die Watches und
   das Log leben nur im Arbeitsspeicher. Ein Absturz oder ein Neustart verliert alles.
2. **Datensicherheit im Alltag**: Löschen ist endgültig (kein Papierkorb), es gibt kein Undo,
   und Sync-Konflikte können in der UI nicht aufgelöst werden.
3. **Performance auf entfernten Systemen**: Viele Operationen laufen Datei für Datei über das
   Protokoll (rekursives chmod, rekursives Löschen, Ordnergröße, Inhaltssuche, Prüfsummen auf
   Objektspeichern), obwohl `exec` beziehungsweise Objekt-Metadaten eine Abkürzung böten.

Außerdem meldet GitHub für den `main`-Branch sieben Dependabot-Schwachstellen in den
Abhängigkeiten (2 kritisch, 2 hoch, 3 mittel); eine `dependabot.yml` und ein Audit-Schritt in
der CI fehlen. Das sollte vor dem nächsten Release bereinigt werden (siehe Abschnitt 4).

### Die zehn wichtigsten Empfehlungen

| # | Thema | Nutzen | Aufwand |
|---|---|---|---|
| 1 | Job-Queue und Sessions persistieren, beim Start wiederherstellen | Kein Datenverlust bei Absturz, Weiterarbeiten nach Neustart | M |
| 2 | Papierkorb für lokale Löschungen, Undo für Umbenennen/Verschieben | Schutz vor dem häufigsten Bedienfehler | S–M |
| 3 | Serverseitige Abkürzungen über `exec` (`rm -rf`, `chmod -R`, `du`, `find`, `grep`) | Operationen auf SSH-Hosts um Größenordnungen schneller | M |
| 4 | Prüfsummen aus Objekt-Metadaten (S3 ETag, Azure Content-MD5, GCS md5Hash) und mtime in Metadaten speichern | Fingerprints und Sync werden auf S3/Azure/GCS erst damit praktikabel | M |
| 5 | Sync-Konflikte in der Checkliste auflösen, Sync-Profile speichern | Zwei-Wege-Sync wird nutzbar, wiederkehrende Syncs mit einem Klick | M |
| 6 | Auto-Update, Desktop-Benachrichtigungen, Fensterzustand, Code-Signing | Reife der Desktop-App, weniger Warnungen bei Installation | M |
| 7 | Mehrbenutzer, 2FA und dauerhafte API-Tokens im Web-Modus | `rcmd serve` im Team und in Automatisierung einsetzbar | L |
| 8 | Dateizwischenablage (Ctrl+C/X/V), Mehrfach-Umbenennen, Verzeichnis-Tabs pro Panel | Grundausstattung eines Commanders | M |
| 9 | Log-Viewer mit „Follow“ (tail -f) und Streaming großer Dateien | Kernnutzen für Admins, heute bei 8 MiB Schluss | M |
| 10 | Playwright-Smoke-Test und Protokoll-Integrationstests in der CI | Regressionen werden vor dem Merge sichtbar | S–M |

Aufwand: S = Stunden, M = ein bis wenige Tage, L = eine Woche oder mehr, XL = mehrere Wochen.

---

## 2. Fehlende Features nach Bereich

### 2.1 Dateiverwaltung in den Panels

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Papierkorb** | `LocalVfs::remove_file` löscht endgültig; `DeleteTask` kennt keinen Papierkorb. Für das lokale Dateisystem sollte F8 standardmäßig in den System-Papierkorb verschieben (Crate `trash`), Shift+F8 endgültig löschen. | Hoch | S |
| **Undo** | Kein Rückgängig für Umbenennen, Verschieben, Löschen. Ein einstufiges Undo für Rename/Move ist über die bestehenden `fs.rename`-Aufrufe leicht machbar. | Mittel | S |
| **Dateizwischenablage** | `ui/src/actions/shortcuts.ts` kennt kein Ctrl+C/Ctrl+X/Ctrl+V für Dateien (nur Ctrl+Shift+C für Pfade). Kopieren und Einfügen zwischen Panels und Sessions über eine App-interne Zwischenablage. | Hoch | S |
| **Mehrfach-Umbenennen** | Kein Werkzeug für Muster-, Zähler- oder RegEx-basiertes Umbenennen vieler Dateien (klassisches Commander-Feature). | Mittel | M |
| **Verzeichnis-Tabs pro Panel** | `ui/src/store/panels.ts` hält genau einen Pfad pro Seite. Session-Tabs gibt es, aber keine Tabs für mehrere Verzeichnisse derselben Session (Ctrl+T ist bereits durch das Terminal belegt). | Mittel | M |
| **Spaltenkonfiguration und Ansichten** | Spalten lassen sich nur in der Breite ändern (`useColumns` in `FileTable.tsx`), nicht ein- oder ausblenden. Keine Kurz- oder Miniaturansicht, keine Ordnergrößen-Spalte. | Niedrig | M |
| **Schnellansicht (Quick View)** | F3 öffnet den Viewer als Vollbild-Editor. Eine Vorschau im jeweils anderen Panel (wie in Total Commander) fehlt. | Mittel | M |
| **Vorschau weiterer Typen** | Der Viewer kennt Text, Bild, PDF und Hex (`EditorKind`). Video/Audio (nativ im Webview), gerendertes Markdown und CSV als Tabelle fehlen. Der Hex-Dump zeigt nur die ersten 4 KiB und ist nicht navigierbar. | Niedrig | S–M |
| **Pfadleiste** | `PathBar.tsx` bietet beim Editieren (Ctrl+L) keine Autovervollständigung, obwohl `OpenFileDialog.tsx` sie bereits implementiert; kein Verlaufs-Dropdown. | Niedrig | S |
| **Verzeichnisvergleich** | *Commands → Compare with other panel* (`compareDirectories` in `panels.ts`) vergleicht nur die aktuelle Ebene nach Zeit und Größe. Rekursiver Vergleich und Vergleich nach Inhalt würden die vorhandene Fingerprint-Engine nutzen können. | Niedrig | S |
| **Öffnen mit …** | Nur die Standardanwendung des Systems (`app.open`); keine Auswahl einer Anwendung, keine konfigurierbaren Viewer pro Dateityp. | Niedrig | M |

### 2.2 Transfers und Warteschlange

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Persistente Queue** | `JobQueue` (`crates/rc-core/src/jobs.rs`) hält Jobs in einem `Vec` im Speicher. Nach Neustart oder Absturz sind laufende und wartende Transfers weg. Speichern von `JobSpec` plus Optionen als JSON im Konfigurationsverzeichnis und Wiederaufnahme beim Start (mit `OverwriteMode::Resume`). | Hoch | M |
| **Queue-Steuerung** | Es gibt nur Pause/Resume/Cancel/Retry pro Job. Fehlt: Reihenfolge ändern, Priorität, „Alle pausieren/fortsetzen/abbrechen“, Geschwindigkeitslimit zur Laufzeit (`RateLimiter::set` existiert, hat aber keinen RPC), ein globales Bandbreitenlimit und ein Zeitplan für Bandbreite. | Mittel | S–M |
| **Nur Fehlgeschlagene wiederholen** | `JobQueue::retry` startet den gesamten Job neu; bei Modus *Overwrite* werden alle Dateien erneut kopiert. Ein Retry, der nur die Pfade aus `errors` nimmt, wäre genauer. | Mittel | S |
| **Automatischer Retry mit Backoff** | `ReconnectingVfs` versucht genau einen Reconnect pro Fehler. Transiente Fehler (Timeouts, 5xx bei Objektspeichern) sollten pro Datei mit exponentiellem Backoff wiederholt werden, bevor sie als Fehler zählen. | Mittel | S |
| **Browser-Uploads fortsetzen** | `/api/upload` unterstützt `offset`, aber `uploadToSession` in `ui/src/api/web.ts` nutzt ihn nicht; ein abgebrochener Upload beginnt von vorn. | Mittel | S |
| **Mehrere SSH-Verbindungen pro Session** | `SftpVfs` nutzt genau eine SSH-Verbindung; `parallel` teilt deren Fenster. Für hohe Latenzen oder viele kleine Dateien würde ein Pool aus 2 bis 4 Verbindungen (wie `ftp/pool.rs`) den Durchsatz deutlich erhöhen. | Mittel | M |
| **Transferprotokoll** | Das Log hält 2000 Einträge im RAM (`crates/rc-api/src/logs.rs`). Es gibt keine persistente Transfer-Historie, keinen Export und keinen Bericht pro Job. | Niedrig | S |
| **Benachrichtigungen** | Kein `tauri-plugin-notification`: Wer die App in den Hintergrund legt, erfährt nichts vom Ende eines Transfers oder von einer Konfliktfrage. | Mittel | S |
| **Objektspeicher** | Upload-Resume, Zeitstempel und Rechte sind laut `limitations.md` nicht möglich. Multipart-Uploads lassen sich jedoch fortsetzen (Upload-ID merken), und mtime kann als Benutzer-Metadatum gespeichert werden (siehe 3.2). | Mittel | M |

### 2.3 Synchronisation und „Keep up to date“

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Konflikte auflösen** | `SyncTask::run` ignoriert Aktionen vom Typ `Conflict` komplett (`sync.rs`), die Checkliste lässt sie unangehakt. Der Benutzer muss die Dateien einzeln von Hand kopieren. Nötig: pro Konflikt „links gewinnt / rechts gewinnt / beide behalten / überspringen“ plus Diff-Knopf direkt in der Zeile. | Hoch | M |
| **Sync-Profile** | Die Parameter des Sync-Dialogs lassen sich nicht speichern. Wiederkehrende Syncs (Deployment, Backup) müssen jedes Mal neu zusammengeklickt werden. Profile mit Namen, eventuell pro Site, und ein Menüpunkt „Letzte Synchronisation wiederholen“. | Mittel | S–M |
| **Zeitgesteuerte Aufgaben** | Weder Sync noch Transfers lassen sich planen (täglich, beim Verbinden). Mit persistenter Queue und Profilen wäre ein einfacher Scheduler im Backend naheliegend, auch für `rcmd serve`. | Mittel | M |
| **Checksummen parallelisieren** | In `sync::compare` werden die `checksum_candidates` sequenziell geprüft; bei vielen gleich großen Dateien dominiert das die Laufzeit. `buffer_unordered` wie in `TransferTask`. | Mittel | S |
| **Zeittoleranz pro Protokoll** | Vorgabe sind 2 Sekunden. FTP-Server ohne MLSD liefern Minutenauflösung, FAT-Dateisysteme 2 Sekunden, Objektspeicher die Upload-Zeit. Eine protokollabhängige Vorgabe (und ein Hinweis im Dialog) verhindert Scheinunterschiede. | Mittel | S |
| **Watch persistieren und erweitern** | Watches (`state.watches`) überleben keinen Neustart, lassen sich nicht pausieren und arbeiten nur lokal → remote. Ein Polling-Watch für remote → lokal (Log-Verzeichnisse, Exporte) wäre mit `ops::walk` einfach. | Niedrig | M |

### 2.4 Protokolle und Verbindungen

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **SMB/CIFS** | Fehlt. Für NAS- und Windows-Freigaben der am häufigsten gewünschte Zugang eines Dateimanagers. Reine Rust-Clients sind rar (`pavao` bindet libsmbclient), daher eher L. | Mittel | L |
| **Rsync-Delta-Transfer** | Fehlt. Auf SSH-Hosts mit installiertem `rsync` ließe sich ein „rsync über exec“ als Transfermodus anbieten, der nur Änderungen überträgt. | Niedrig | L |
| **Consumer-Clouds** | Google Drive, OneDrive und Dropbox fehlen. OpenDAL (bereits Abhängigkeit) bringt Services dafür mit; der Aufwand steckt im OAuth-Flow (Browser-Rückruf im Desktop, Gerätecode im Web-Modus). | Niedrig | M–L |
| **SSH: Remote-Forwarding und Agent-Forwarding** | `TunnelKind` kennt nur `Local` (-L) und `Dynamic` (-D). `-R` und Agent-Forwarding fehlen. | Niedrig | S–M |
| **SSH: `ProxyCommand`** | Der `~/.ssh/config`-Import (`store/import.rs`) wertet `ProxyJump` aus, `ProxyCommand` nicht. Hosts, die darüber erreichbar sind, lassen sich weder importieren noch im Remote Explorer öffnen. | Niedrig | M |
| **SSH: Host-Zertifikate, Security Keys** | CA-signierte Host-Keys sind laut `limitations.md` nicht unterstützt; FIDO-Schlüssel (`sk-*`) funktionieren nur über den Agent. | Niedrig | M |
| **WebDAV** | Nur HTTP Basic (Digest und Bearer/OAuth fehlen), kein LOCK/UNLOCK. | Niedrig | S–M |
| **S3/Azure/GCS** | Keine Freigabe-Links (presigned URLs), keine Anzeige oder Bearbeitung von Objekt-Metadaten, Tags, Storage-Class oder Versionen, kein Anlegen von Buckets. „Link kopieren“ für ein Objekt wäre ein kleiner, sehr sichtbarer Gewinn. | Mittel | S–M |
| **Letzte Verbindungen** | Weder Site Manager noch Backend merken sich zuletzt genutzte Sites oder Ad-hoc-URLs (kein Treffer für `recent` in `SiteManager.tsx`/`sites.rs`). Eine Liste „Zuletzt verbunden“ und ein Zähler pro Site. | Mittel | S |
| **Sessions beim Start wiederherstellen** | `AppState::new` legt nur die lokale Session an; die UI fällt auf *Local* zurück, wenn die gespeicherte Session fehlt. Option „Beim Start wieder verbinden“ (Workspace) pro Site oder global. | Hoch | S–M |
| **Site-Export mit Secrets** | Export ist bewusst ohne Geheimnisse. Für Umzug und Backup fehlt ein passwortgeschützter, verschlüsselter Export (die Vault-Primitiven sind vorhanden). | Niedrig | S |

### 2.5 Editor

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Große Dateien, Follow-Modus** | `MAX_TEXT` = 8 MiB; größere Dateien werden abgeschnitten und schreibgeschützt geöffnet (`store/editors.ts`). Für Logdateien fehlt ein Streaming-Viewer mit „Folgen“ (tail -f), Springen ans Ende und Suche. Heute geht das nur über das Custom Command `tail -n 200`. | Hoch | M |
| **Suchen/Ersetzen über mehrere Dateien** | Nur innerhalb eines Tabs. | Niedrig | M |
| **Sicherungskopie vor dem Speichern** | Kein optionales `.bak` oder Backup-Verzeichnis beim Überschreiben. Der Vergleich mit dem Serverstand existiert bereits. | Niedrig | S |
| **Autovervollständigung/Snippets** | Nicht vorhanden; für einen Dateimanager-Editor vertretbar, aber Wort-Vervollständigung aus dem Dokument ist in CodeMirror 6 günstig. | Niedrig | S |
| **Als root bearbeiten** | Nur über das pro Site konfigurierte SFTP-Server-Kommando. Ein „Mit sudo speichern“ über `exec` (`sudo tee`) für SSH-Sessions wäre pragmatischer. | Niedrig | S–M |

### 2.6 Suche

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Serverseitige Suche über SSH** | `search::contains` liest jede Kandidatendatei vollständig über das Protokoll (`search.rs`). Auf SFTP/SCP-Sessions mit `exec` sollten `find` und `grep -l` die Arbeit übernehmen, so wie es die Prüfsummen bereits tun. | Hoch | S–M |
| **Reguläre Ausdrücke** | Namensmaske ist Glob, Inhaltssuche ist Klartext; kein RegEx. | Niedrig | S |
| **Aktionen auf Ergebnisse** | Treffer bieten nur „Anzeigen im Panel“, „Bearbeiten“, „Ansehen“, „Pfad kopieren“ (`SearchView.tsx`). Mehrfachauswahl mit Kopieren/Löschen und „Ergebnisse ins Panel laden“ fehlen. | Mittel | S–M |
| **Suche in Archiven, Export** | Nicht vorhanden. | Niedrig | M |

### 2.7 Web-Modus und Server

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Mehrere Benutzer und Rollen** | `ServerAuth` kennt genau ein Passwort. Keine Benutzerkonten, keine Nur-Lese-Rolle, kein Audit „wer hat was getan“. Für den Einsatz im Team unerlässlich. | Hoch | L |
| **Zweiter Faktor** | Kein TOTP, kein OIDC/SSO. | Mittel | M |
| **Dauerhafte API-Tokens** | Der Bearer-Token entsteht nur beim Login und wird beim Logout widerrufen. Für Scripts und CI gegen `rcmd serve` fehlen benannte, widerrufbare Tokens. | Mittel | S–M |
| **Reverse-Proxy-Betrieb** | Die Login-Drosselung nutzt `ConnectInfo` (die Adresse des Proxys). Eine Option `--trusted-proxy` mit Auswertung von `X-Forwarded-For` fehlt. | Mittel | S |
| **TLS** | Nur selbstsigniert oder PEM-Dateien im Konfigurationsverzeichnis; keine `--cert/--key`-Flags, kein ACME (Let's Encrypt). | Niedrig | S / M |
| **Web-Sessions verwalten** | Cookie-Laufzeit fest 7 Tage; keine Übersicht aktiver Sitzungen, kein „Alle abmelden“. | Niedrig | S |
| **PWA** | `ui/index.html` hat kein Web-App-Manifest und keinen Service Worker. Ein Manifest würde „Zum Startbildschirm hinzufügen“ auf dem Handy ermöglichen (Vollbild, Icon). | Niedrig | S |
| **Persistentes Log** | Siehe 2.2; für einen Server zusätzlich eine Datei oder das Journal mit Rotation. | Niedrig | S |

### 2.8 Desktop-Integration

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Auto-Update** | `src-tauri/Cargo.toml` enthält nur `tauri-plugin-dialog`. Trotz fertiger Release-Pipeline gibt es keine Update-Prüfung in der App (`tauri-plugin-updater` plus signierte `latest.json`). | Hoch | M |
| **Code-Signing und Notarisierung** | `signingIdentity` ist `-` (ad hoc), die Installationsanleitung erklärt, wie man Gatekeeper und SmartScreen umgeht. Ein Apple-Developer-Zertifikat und ein Windows-Signaturzertifikat beseitigen die Warnungen. | Mittel | S (plus Kosten) |
| **Fensterzustand** | Größe und Position werden nicht gespeichert (`tauri-plugin-window-state` fehlt). | Mittel | S |
| **Benachrichtigungen, Tray** | Keine Systembenachrichtigungen; kein Tray-Symbol für laufende Transfers oder Watches bei geschlossenem Fenster. | Mittel | S–M |
| **URL-Handler** | Keine Registrierung für `sftp://`, `ftp://`, `s3://` (`tauri-plugin-deep-link`), kein „Öffnen mit Rust Commander“ im System. | Niedrig | S |
| **Drag aus der App heraus** | Dateien lassen sich ins Fenster, aber nicht aus dem Fenster ins Betriebssystem ziehen (Tauri bietet dafür `start_drag` über Plugins). | Niedrig | M |
| **Portabler Modus** | Die portable Windows-EXE schreibt trotzdem nach `%APPDATA%`; ein `portable`-Marker neben der EXE (Konfiguration im Programmordner) fehlt. | Niedrig | S |
| **Tastenkürzel anpassen** | `BINDINGS` in `shortcuts.ts` ist fest verdrahtet. | Niedrig | M |
| **Sprachen** | Nur Englisch und Deutsch; die i18n-Infrastruktur ist vollständig (1047 Schlüssel, beide Dateien deckungsgleich). Weitere Sprachen sind Fleißarbeit. | Niedrig | S pro Sprache |

### 2.9 Kommandozeile und Scripting

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Einzelbefehle** | `rcmd` kennt nur `serve`, `set-password`, `discover`, `script`, `sites`. Für Cron und CI wären `rcmd get/put/sync/ls <url>` ohne Script-Datei ergonomischer. | Mittel | S–M |
| **Variablen und Parameter** | Scripts kennen keine Platzhalter (`%1%`, Umgebungsvariablen); `option` wird ignoriert. | Niedrig | S |
| **Maschinenlesbare Ausgabe** | Kein `--json` für `ls`, `stat`, `synchronize -preview` oder Job-Ergebnisse. | Niedrig | S |
| **Site-Verwaltung** | `rcmd sites` listet nur; Anlegen, Löschen, Import und Export per CLI fehlen. | Niedrig | S |
| **Konflikte in Scripts** | `run_job` antwortet auf jede Überschreibfrage mit *Overwrite*; `synchronize` lässt Konflikte stillschweigend weg. Ein Schalter (`-conflict=skip|left|right|fail`) und ein Exit-Code dafür fehlen. | Mittel | S |
| **`keepuptodate` als Dienst** | Blockiert bis Ctrl+C; in `rcmd serve` lässt sich kein Watch dauerhaft konfigurieren. | Niedrig | S–M |
| **Shell-Completion** | Keine Vervollständigung für bash/zsh/fish (`clap_complete`). | Niedrig | S |

### 2.10 Sicherheit

| Feature | Befund | Priorität | Aufwand |
|---|---|---|---|
| **Vault automatisch sperren** | Sperren geht nur manuell (`vault.lock`); kein Timeout, kein Sperren beim Bildschirmschoner. | Mittel | S |
| **OS-Schlüsselbund** | Ohne Master-Passwort liegt der Schlüssel in `vault.key` auf der Platte. Alternativ Keychain (macOS), Credential Manager (Windows) und Secret Service (Linux) über das Crate `keyring`. | Mittel | S–M |
| **Known Hosts** | Nur Auflisten und Entfernen; kein Import aus `~/.ssh/known_hosts` in den eigenen Store, kein Export. | Niedrig | S |
| **Web-Zugriffskontrolle** | Keine IP-Allowlist, Drosselungs-Parameter nicht konfigurierbar. | Niedrig | S |
| **Agent-Bestätigung** | Signaturen über den Agent (`ssh-add -c`, Hardware-Token) warten ohne Hinweis in der UI; ein Hinweis „Bitte am Token bestätigen“ fehlt. | Niedrig | S |

---

## 3. Bestehende Features mit Verbesserungsbedarf

### 3.1 Serverseitige Abkürzungen über `exec`

Die `Vfs`-Schicht kennt `exec` und nutzt es bereits für Prüfsummen (`sha256sum` über SSH).
Dieselbe Idee fehlt an vier Stellen, die auf SSH-Hosts heute Datei für Datei arbeiten:

| Operation | Heute | Besser |
|---|---|---|
| Rekursives Löschen | `DeleteTask` listet den Baum und löscht mit vier parallelen SFTP-Requests (`transfer.rs`) | `rm -rf` über `exec`, mit Fallback auf den heutigen Weg |
| Rekursive Rechte | `fs::set_attributes` ruft `set_permissions` pro Eintrag nacheinander (`handlers/fs.rs`) | `chmod -R` beziehungsweise `find -type f -exec chmod` |
| Ordnergröße | `ops::dir_size` über `walk` | `du -sk` |
| Suche | `walk` plus Download jeder Datei bei Inhaltssuche (`search.rs`) | `find` und `grep -l` |

Alle vier sind an `capabilities().exec` gebunden und brauchen eine Zeichenkettenquotierung,
die `protocols/ssh/shell.rs` schon hat.

### 3.2 Prüfsummen und Zeitstempel auf Objektspeichern

`CloudVfs` setzt `server_checksum: false` (`protocols/cloud/mod.rs`). Für einen
Fingerprint-Vergleich oder `OverwriteMode::DifferentChecksum` wird deshalb jedes Objekt
vollständig heruntergeladen und gehasht. Dabei liefern die Dienste die Prüfsumme kostenlos
mit: S3 den ETag (MD5 bei Einzel-Uploads), Azure `Content-MD5`, GCS `md5Hash`. OpenDAL
stellt diese Werte in `Metadata` bereit. Vorschlag: `checksum(path, Md5)` aus den Metadaten
beantworten, wenn das Objekt nicht multipart hochgeladen wurde, und die
Fingerprint-Dialoge standardmäßig den Algorithmus wählen lassen, den beide Seiten
serverseitig können.

Zeitstempel: Da `set_modified` auf Objektspeichern nicht geht, ist die Änderungszeit dort
immer die Upload-Zeit. Ein Zeitvergleich in der Synchronisation ist damit wertlos: *Mirror*
kopiert bei jedem Lauf alles, *Both* meldet lauter Konflikte. rclone und s3cmd speichern die
ursprüngliche mtime als Benutzer-Metadatum (`x-amz-meta-mtime`). Dasselbe hier beim Upload
setzen und in `list`/`stat` zurücklesen würde Sync mit S3/Azure/GCS auf einen Schlag
brauchbar machen und `set_modified` für neue Objekte sogar möglich.

### 3.3 Job-Queue

- `jobs.retry` wiederholt den gesamten Job (siehe 2.2).
- Die Fehlerliste pro Job ist auf 1000 Einträge begrenzt und in der UI auf 200; ein Filter
  und ein Export fehlen.
- Der Fortschritt bei `scanning` ist unbestimmt; beim Scannen großer Bäume sieht der
  Benutzer lange keine Zahl. Ein Zähler „n Dateien gefunden“ während des Scans ist mit
  `add_total` bereits vorhanden und müsste nur angezeigt werden.

### 3.4 Remote Explorer

Der Explorer kann nur SSH-Ziele (`explorer::targets`), obwohl er technisch ein Baum über
einem beliebigen `Vfs` ist. FTP-, WebDAV- und Bucket-Sites als Baum anzuzeigen wäre
überwiegend UI-Arbeit und würde den Explorer zur allgemeinen Baumansicht machen.

### 3.5 Terminal

Nur `@xterm/addon-fit` ist eingebunden. Suche im Terminal, klickbare Links und eine
Zwischenablage-Integration liefern die Addons `addon-search`, `addon-web-links` und
`addon-clipboard` praktisch kostenlos. Terminal-Tabs lassen sich nicht umbenennen oder
teilen.

### 3.6 Conflict-Dialog und Überschreibmodi

- *Apply to all* gilt nicht für *Rename* (gewollt), aber auch nicht für „Keep both“ mit
  automatischem Suffix; genau das wäre bei vielen Konflikten hilfreich.
- `OverwriteMode::Newer` überschreibt, wenn das Ziel keine mtime hat. Bei Objektspeichern
  (siehe 3.2) führt das zu überraschendem Verhalten.

### 3.7 Panels

- Der Quick-Filter geht beim Verzeichniswechsel verloren (gewollt), aber auch die
  Sortierung ist nur pro Panel, nicht pro Session oder Verzeichnis merkbar.
- *Synchronized browsing* schaltet sich beim ersten fehlenden Ordner ab; ein Angebot „Ordner
  im anderen Panel anlegen“ wäre nützlicher.
- Session-Tabs lassen sich weder sortieren noch umbenennen.

---

## 4. Qualität, Tests, CI

| Befund | Empfehlung | Aufwand |
|---|---|---|
| Der Playwright-Smoke-Test (`ui/tests/smoke.mjs`) läuft nicht in der CI; `ci.yml` ruft nur `test:unit`. | Chromium in der CI installieren (`npx playwright install --with-deps chromium`) und `npm test` ausführen; Screenshots als Artefakt hochladen. | S |
| Die Protokoll-Integrationstests (SSH, FTP, WebDAV, S3, Azure) laufen nur mit Umgebungsvariablen lokal. | Ein CI-Job mit Docker-Services (OpenSSH, pyftpdlib, WsgiDAV, moto, Azurite), die Skripte unter `crates/rc-core/tests/servers/` existieren bereits. | M |
| Windows- und macOS-Builds wurden nie manuell getestet (`limitations.md`). | Mindestens ein manueller Durchlauf pro Release; mittelfristig ein Playwright-Lauf gegen die echte Tauri-App (`tauri-driver`). | S / L |
| GCS ist nicht gegen den echten Dienst getestet. | Fake-GCS-Server (`fsouza/fake-gcs-server`) in den Cloud-Testjob aufnehmen. | S |
| Keine Durchsatz-Benchmarks. | Ein Criterion-Benchmark für `TransferTask` lokal→lokal und gegen den Test-SSH-Server, um Regressionen (Chunkgrößen, Pipeline) zu erkennen. | S |
| Die i18n-Dateien sind deckungsgleich (1047 Schlüssel). | Ein kleiner Test, der das dauerhaft sicherstellt, verhindert Rückfälle. | S |
| GitHub meldet sieben Dependabot-Schwachstellen auf `main` (2 kritisch, 2 hoch, 3 mittel): https://github.com/bobnautic/rustCommander/security/dependabot. Es gibt keine `.github/dependabot.yml`, und die CI führt weder `cargo audit` noch `npm audit` aus. | Betroffene Crates und npm-Pakete aktualisieren, Dependabot für Cargo und npm aktivieren, `cargo audit` (oder `cargo deny`) und `npm audit --omit=dev` als CI-Schritte aufnehmen. | S |

---

## 5. Vorschlag für eine Reihenfolge

**0.2 (Robustheit und Datensicherheit)**
Persistente Queue und Session-Wiederherstellung · Papierkorb und Undo · Sync-Konflikte
auflösen · Serverseitige Abkürzungen über `exec` · Metadaten-Prüfsummen und mtime auf
Objektspeichern · Smoke-Test in der CI.

**0.3 (Desktop-Reife und Alltag)**
Auto-Update, Benachrichtigungen, Fensterzustand, Code-Signing · Dateizwischenablage,
Mehrfach-Umbenennen, Verzeichnis-Tabs · Log-Viewer mit Follow · Sync-Profile und
Zeitplan · Letzte Verbindungen · Vault-Auto-Lock und OS-Schlüsselbund.

**0.4 (Server und Team)**
Mehrbenutzer mit Rollen, 2FA, API-Tokens · Reverse-Proxy-Option · persistentes Log ·
`rcmd`-Einzelbefehle und `--json` · PWA-Manifest.

**Später**
SMB, Rsync, Consumer-Clouds · Quick-View-Panel und weitere Vorschauen · konfigurierbare
Tastenkürzel · weitere Sprachen.

---

## 6. Methodik

Gelesen wurden: die RPC-Schnittstelle (`ui/src/api/types.ts`, `crates/rc-api/src/dispatch.rs`),
alle Handler in `rc-api`, die Kernmodule `vfs`, `types`, `transfer`, `jobs`, `sync`, `search`,
`watch`, `archive`, `reconnect`, `ops`, `connect`, `site`, `prompt`, die Capabilities aller
Protokolle, die SSH-Verbindung und -Authentifizierung, der Web-Server (`routes.rs`), die CLI
und das Scripting, sowie auf UI-Seite Shortcuts, Menüs, Kontextmenü, Panels, Stores,
Dateioperationen, Editor-Store, Queue, Terminal, Einstellungen und der Copy-Dialog. Dazu die
gesamte Dokumentation, `limitations.md`, beide CI-Workflows und die Tauri-Konfiguration.
Jede als „fehlend“ bezeichnete Funktion wurde im Code gegengeprüft (keine Treffer für
Papierkorb, Dateizwischenablage, letzte Verbindungen, Job-Persistenz, Updater, Window-State,
Benachrichtigungen, Manifest, `ProxyCommand`).
