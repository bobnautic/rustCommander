# Rust Commander

Ein Zwei-Fenster-Dateimanager und Transfer-Client, komplett in **Rust** geschrieben, mit einer **Tauri**-Oberfläche. Rust Commander läuft als Desktop-App (Windows, macOS, Linux) und zusätzlich **headless auf einem Zielhost**. Dort stellt er dieselbe Oberfläche im Browser bereit. Laufende Instanzen **finden sich gegenseitig im LAN** und lassen sich direkt aus der App heraus öffnen.

| Desktop: andere Instanz als Panel eingebunden | Web: SFTP-Sitzung mit Terminal auf dem Zielhost |
|---|---|
| ![Desktop](docs/screenshots/desktop-peer-panel.png) | ![Web](docs/screenshots/web-sftp-terminal.png) |
| **Desktop: „Diese Instanz freigeben“** | **Web: Instanzen in der Nähe (LAN-Discovery)** |
| ![Freigabe](docs/screenshots/desktop-share.png) | ![Nearby](docs/screenshots/web-nearby.png) |

## Funktionen

### Funktionsumfang

| Bereich | Rust Commander |
|---|---|
| Protokolle | **SFTP**, **SCP**, **FTP**, **FTPS** (explizit/implizit), **WebDAV(S)**, **Amazon S3** und S3-kompatible Speicher (MinIO, Wasabi, R2, Ceph …) |
| Oberfläche | Commander-Ansicht mit zwei Panels, Lesezeichen, synchronisiertes Browsen, Verzeichnisvergleich, Tastaturbedienung (F2–F8, Ins, Strg+…) |
| Anmeldung | Passwort, Public Key (OpenSSH/PEM, verschlüsselt), SSH-Agent/Pageant, Keyboard-Interactive (2FA/OTP), Jump-Host (ProxyJump), SOCKS5/HTTP-Proxy, eigener SFTP-Server-Befehl (z. B. `sudo /usr/lib/openssh/sftp-server`) |
| Sicherheit | Host-Key-Prüfung mit TOFU und Warnung bei geänderten Schlüsseln, Abgleich mit `~/.ssh/known_hosts`, TLS-Zertifikatsprüfung |
| Seitenverwaltung | Ordner, Farben, Notizen, Import aus **FileZilla** (`sitemanager.xml`) und **`~/.ssh/config`**, JSON-Export, URLs (`sftp://user@host:22/pfad`) |
| Übertragungen | Hintergrund-Warteschlange mit Pause/Fortsetzen/Abbrechen/Wiederholen, Fortsetzen abgebrochener Übertragungen, Überschreib-Nachfrage (Überschreiben/Überspringen/Fortsetzen/Umbenennen/Nur neuere/Nur bei abweichendem Inhalt), **Fingerprint-Vergleich von Quelle und Ziel vor dem Kopieren**, Zeitstempel und Rechte erhalten, Text-/Binärmodus, Dateimasken (`*.txt; *.log \| tmp/; >10M; <7D`), Geschwindigkeitslimit, Upload über temporäre Datei, Verschieben |
| Synchronisation | Vergleichen in eine Richtung oder in beide (Größe/Zeit/Prüfsumme), Spiegeln, verwaiste Dateien löschen, **Checkliste** vor dem Ausführen, „Remote-Verzeichnis aktuell halten“ (Dateisystem-Überwachung) |
| Dateioperationen | Umbenennen, Löschen (rekursiv als Job), Ordner/Datei anlegen, symbolische Links, Eigenschaften (chmod rekursiv, getrennte Ordnerrechte, chown, Änderungsdatum), Ordnergröße, Prüfsummen (MD5/SHA-1/SHA-256) |
| Editor | Integrierter Editor für lokale und entfernte Dateien: Spracherkennung (Dateiname, Shebang, Inhalt), **Linting** und **Formatieren** je nach Sprache, Änderungs- und Diff-Ansicht, Statusleiste mit Einrückung/Zeilenende/Kodierung; Bearbeiten mit externer Anwendung, die Datei wird beim Speichern automatisch hochgeladen |
| Weitere | Dateien suchen (Name, Größe, Datum, Inhalt), benutzerdefinierte Befehle (`!`, `!&`, `!/`, `!@`, `!U`), Befehle auf dem Server ausführen, Sitzungsinformationen, Protokoll-Panel |
| Scripting | `rcmd script`: Batch-Befehle (`open`, `ls`, `cd`, `get`, `put`, `synchronize`, `keepuptodate`, `chmod`, `checksum` …) |

### Weitere Funktionen

- **Webmodus auf dem Zielhost** – `rcmd serve` startet Rust Commander ohne GUI auf einem Server. Vom Quellhost aus öffnet man `https://zielhost:8822/` im Browser und bekommt die komplette Oberfläche mit dem Dateisystem des Zielhosts. Von dort aus kann man auch zu weiteren Servern verbinden. Uploads und Downloads laufen direkt zwischen Browser und Zielhost (Ordner werden als ZIP gestreamt).
- **LAN-Discovery** – Instanzen kündigen sich per UDP-Broadcast und Multicast an (Port 47800) und erscheinen in der Seitenleiste **„In der Nähe“**. Die Weboberfläche lässt sich dort per Klick öffnen, oder man bindet die andere Instanz **als Dateipanel** ein (Protokoll `rcmd`, TLS mit Fingerprint-Pinning). Instanzen in anderen Netzen kann man über ihre Adresse hinzufügen.
- **Diese Instanz freigeben** – Die Desktop-App kann ihre eigene Oberfläche ebenfalls im Netz anbieten (Passwort, HTTPS).
- **Remote-Explorer** – Seitenleiste (Strg+Umschalt+E) mit allen SSH-Zielen: gespeicherte SFTP/SCP-Verbindungen und die Hosts aus `~/.ssh/config` (ohne Import, inklusive `ProxyJump`), oder einfach `user@host[:port]` eintippen. Ordner klappt man als Baum auf, ein Klick auf eine Datei zeigt Details und eine Vorschau der ersten 64 KiB. Auf dem Zielhost wird nichts installiert, und es werden keine Dateien kopiert. Dateien öffnet man per Doppelklick oder F4 direkt im Editor; gespeichert wird über dieselbe SSH-Verbindung. Hat ein Server kein SFTP (z. B. Router oder Appliances mit Dropbear), listet der Explorer über dieselbe SSH-Verbindung mit Shell-Befehlen (`ls`).
- **Integriertes Terminal** – SSH-Shell und lokale Shell in Tabs (xterm.js).
- **Port-Weiterleitung** – Lokale Weiterleitung (`-L`) und dynamischer SOCKS5-Proxy (`-D`) über SSH-Sitzungen.
- **Cloud-Speicher** – Azure Blob Storage und Google Cloud Storage zusätzlich zu S3.
- **Server-zu-Server-Kopien** – Beide Panels können beliebige Sitzungen zeigen, z. B. SFTP → S3 oder FTP → SFTP, ohne Umweg über die lokale Platte.
- **Archive** – ZIP, TAR und TAR.GZ lokal erstellen und entpacken.
- **Fingerprints vor dem Kopieren** – Vor dem Kopieren zeigt Rust Commander für jede Datei, ob sie im Ziel schon mit gleichem Inhalt liegt, sich unterscheidet oder neu ist (SHA-256, SHA-1 oder MD5). Wo das Protokoll es erlaubt, werden die Prüfsummen dort berechnet, wo die Dateien liegen (`sha256sum` über SSH, `HASH` bei FTP, andere Rust-Commander-Instanzen), ohne die Dateien herunterzuladen; sonst werden sie zum Berechnen gelesen. Dateien unterschiedlicher Größe brauchen gar keine Prüfsumme. Danach kopiert ein Klick nur die geänderten und neuen Dateien; bei Textdateien zeigt eine Diff-Ansicht die Unterschiede.
- **Prüfsummen-Verifikation** nach jeder Übertragung (optional), **parallele Übertragungen** innerhalb eines Jobs.
- **Tresor mit Master-Passwort** – Gespeicherte Passwörter und Schlüssel werden mit XChaCha20-Poly1305 verschlüsselt (Schlüssel per Argon2id aus dem Master-Passwort abgeleitet).
- Helles und dunkles Design, Deutsch und Englisch, angepasste Ansicht für schmale Bildschirme (Webmodus auf dem Handy).

## Architektur

```
crates/
  rc-core        Dateisystem-Abstraktion (Vfs) + Protokolle, Transfer-Warteschlange,
                 Synchronisation, Suche, Tresor, Seitenspeicher, Importe, Tunnel, Archive
  rc-discovery   LAN-Discovery über UDP-Broadcast und Multicast
  rc-api         Anwendungszustand + RPC-Dispatcher (eine API für Desktop und Web)
  rc-server      HTTP(S)-Server: eingebettete UI, /api/rpc, WebSocket-Events,
                 Up-/Download, Login, selbstsigniertes TLS-Zertifikat
  rc-cli         rcmd: serve, discover, script, set-password, sites
src-tauri/       Desktop-App (Tauri 2): Befehl `rpc` + Event `rc-event`
ui/              Oberfläche (React + TypeScript + Vite), identisch für Desktop und Web
```

Die gesamte Logik liegt in Rust. Die Oberfläche spricht immer dieselbe API (`ui/src/api/types.ts`): In der Desktop-App per Tauri-`invoke`, im Browser per `POST /api/rpc` und einem WebSocket für Ereignisse. Deshalb sind Desktop- und Webmodus funktional gleich.

## Bauen

Voraussetzungen: Rust (stable), Node.js ≥ 20. Unter Linux zusätzlich die [Tauri-Abhängigkeiten](https://tauri.app/start/prerequisites/) (`libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `libxdo-dev`).

```bash
# Oberfläche
npm --prefix ui ci
npm --prefix ui run build

# Desktop-App (Entwicklung / Installationspakete)
npm ci
npm run dev          # tauri dev
npm run build        # tauri build -> src-tauri/target/release/bundle/

# Headless-Server + CLI (ohne GUI-Abhängigkeiten)
cargo build --release -p rc-cli     # -> target/release/rcmd
```

## Benutzung

### Desktop

`rust-commander` starten. Mit **Strg+N** öffnet sich die Seitenverwaltung. Links liegt standardmäßig das lokale Dateisystem, rechts der Server. Weitere Funktionen findet man in den Menüs und Kontextmenüs. Die Tastenkürzel entsprechen den klassischen Commander-Programmen (F5 Kopieren, F6 Verschieben, F7 Ordner, F8 Löschen …).

### Auf einem Zielhost im Webmodus

```bash
rcmd set-password                 # einmalig ein Login-Passwort speichern
rcmd serve                        # https://<host>:8822/  (selbstsigniertes Zertifikat)
rcmd serve --port 9000 --no-tls   # nur in vertrauenswürdigen Netzen
rcmd serve --no-terminal          # keine Shell/Befehle für Web-Benutzer
```

Ohne gespeichertes Passwort erzeugt `rcmd serve` ein Einmal-Passwort und gibt es zusammen mit den URLs und dem TLS-Fingerprint aus. Den Fingerprint vergleicht man beim ersten Aufruf im Browser. Dauerbetrieb: `packaging/rust-commander.service` (systemd) oder das `Dockerfile`.

### Remote-Explorer

**Strg+Umschalt+E** (oder das Baum-Symbol in der Werkzeugleiste) öffnet den Explorer in der Seitenleiste. Ein Klick auf ein Ziel verbindet per SSH (Host-Key-Prüfung und Anmeldung wie bei jeder Sitzung) und zeigt Home-Verzeichnis und `/` als Baum. Das Eingabefeld filtert die Ziele; steht dort eine Adresse wie `admin@10.0.0.7:2222`, verbindet Enter direkt dorthin. Pfeiltasten navigieren im Baum, ←/→ klappen zu und auf. Über das Kontextmenü gibt es *Gehe zu Pfad…*, *Im Fenster öffnen* (zeigt den Ordner in einem Dateifenster), *Terminal hier* und *Pfad kopieren*. Die Verbindung erscheint zusätzlich als Sitzungs-Tab und lässt sich dort oder im Explorer trennen.

Im Webmodus sind es die `~/.ssh/config` und die SSH-Schlüssel des Benutzers, unter dem `rcmd serve` läuft.

### Editor

F4 öffnet eine Datei zum Bearbeiten, F3 schreibgeschützt – egal ob sie lokal, auf einem SFTP/SCP/FTP-Server, in einem Bucket oder auf einer anderen Rust-Commander-Instanz liegt. **Strg+P** öffnet beliebige Pfade in jeder verbundenen Sitzung, mit Vervollständigung (Tab) und den zuletzt geöffneten Dateien; nicht vorhandene Dateien werden auf Wunsch angelegt.

- **Sprache** – erkannt am Dateinamen (auch `Dockerfile.prod`, `.bashrc`, `*.service`, `nginx/sites-available/*` …), sonst am Inhalt (Shebang, `vim: ft=`-Zeilen, XML/HTML/JSON/YAML-Kopf). In der Statusleiste lässt sie sich ändern; die Wahl gilt dann für alle Dateien mit dieser Endung.
- **Linting** während der Eingabe: Syntaxfehler mit Zeile und Spalte (JavaScript/TypeScript/CSS über die Parser von Prettier, YAML, TOML, JSON, XML, HTML, Python, Rust, Go, Java), doppelte Schlüssel in JSON und YAML, Merge-Konfliktmarker, gemischte Einrückung und unsichtbare Zeichen. Probleme stehen im Rand und in der Statusleiste; Strg+Umschalt+M listet sie, F8 springt zum nächsten.
- **Formatieren** mit Umschalt+Alt+F, auf Wunsch beim Speichern: Prettier (JavaScript, TypeScript, JSON, CSS/SCSS/LESS, HTML, Vue, Markdown, YAML) übernimmt Einrückung, Anführungszeichen und Semikolons der Datei; dazu SQL (mehrere Dialekte) und XML. Für Rust, Go, Python, Shell, C/C++/Java, TOML und Lua werden `rustfmt`, `gofmt`, `ruff`/`black`, `shfmt`, `clang-format`, `taplo` und `stylua` genutzt, wenn sie auf dem Rechner installiert sind, auf dem Rust Commander läuft.
- **Änderungen sehen** – „Änderungen seit dem Speichern“ markiert geänderte Zeilen und erlaubt, einzelne Änderungen zu verwerfen. Hat jemand die Datei auf dem Server inzwischen geändert, fragt das Speichern nach und bietet einen Vergleich an. Über das Werkzeug-Menü lässt sich die Datei mit der gespeicherten Version oder der gleichnamigen Datei im anderen Fenster vergleichen.
- **Statusleiste** mit Zeile/Spalte, Einrückung (erkannt, umstellbar und umwandelbar), Zeilenenden (LF/CRLF bleiben erhalten), Kodierung (UTF-8, UTF-8 mit BOM, Latin-1) und dem verwendeten Formatierer.
- Außerdem: Tabs behalten Verlauf und Cursor, Gehe zu Zeile (Strg+G), Kommentar umschalten (Strg+/), Zeilen sortieren und Duplikate entfernen, Groß-/Kleinschreibung, Leerzeichen am Zeilenende entfernen, JSON-Schlüssel sortieren oder komprimieren, Leerzeichen anzeigen, Schriftgröße (Strg+= / Strg+-), „Im Dateifenster zeigen“.

### Fingerprints vor dem Kopieren

Im Kopierdialog (F5) prüft **Fingerprints vergleichen**, was die Kopie im Ziel treffen würde; dasselbe geht ohne Kopierdialog mit **Strg+K** (oder im Kontextmenü) für die Auswahl gegen den Ordner im anderen Fenster. Ordner werden rekursiv verglichen. Jede Datei bekommt einen Status: *identisch*, *verschieden* (bei gleicher Größe per Prüfsumme bestimmt), *andere Größe* oder *neu*. „Geänderte oder neue Dateien kopieren“ startet die Übertragung mit dem Überschreibmodus „nur bei abweichendem Inhalt“: Beim Kopieren wird jede vorhandene Datei noch einmal verglichen, sodass nur Dateien mit anderem Inhalt überschrieben werden – auch wenn sich seit dem Vergleich etwas geändert hat. Diesen Modus gibt es auch in den Übertragungseinstellungen. „Bericht kopieren“ legt die Liste mit allen Prüfsummen in die Zwischenablage. Auch die Frage „Datei existiert bereits“ während einer Übertragung kann beide Fingerprints vergleichen und die Unterschiede zeigen.

### Instanzen im Netz finden

```bash
rcmd discover          # listet alle Instanzen im LAN
```

In der App zeigt die Seitenleiste **„In der Nähe“** (Strg+B) dieselbe Liste live an, mit den Aktionen *Weboberfläche öffnen*, *Als Panel verbinden* und *Als Seite speichern*. Discovery lässt sich in den Einstellungen abschalten oder auf einen anderen Port legen. Ankündigungen sind nur Hinweise. Zugriff gibt es immer erst nach dem Login, und das Zertifikat wird gepinnt.

### Scripting

```bash
rcmd script -c "open sftp://user@example.com -hostkey=*" -c "lcd /backup" -c "get /var/log/*.log" -c "exit"
rcmd script deploy.txt
rcmd script            # interaktive Konsole
```

```text
# deploy.txt
open "Produktion/Webserver"          # gespeicherte Seite
synchronize remote ./dist /var/www/html -delete -criteria=checksum
call systemctl reload nginx
exit
```

## Tests

```bash
cargo test --workspace
```

Die Protokoll-Integrationstests laufen nur mit echten Servern und werden über Umgebungsvariablen aktiviert:

- SSH: `RC_TEST_SSH_HOST`, `RC_TEST_SSH_PORT`, `RC_TEST_SSH_USER`, `RC_TEST_SSH_PASSWORD`, `RC_TEST_SSH_KEY`; für den Remote-Explorer zusätzlich `RC_TEST_SSH_NO_SFTP_PORT` (zweiter Server ohne `Subsystem sftp`, siehe Kopfkommentar von `crates/rc-api/tests/explorer.rs`)
- FTP/Cloud: `RC_TEST_FTP_URL`, `RC_TEST_FTPES_URL`, `RC_TEST_FTPS_URL`, `RC_TEST_WEBDAV_URL`, `RC_TEST_S3_ENDPOINT`, `RC_TEST_AZURE_ENDPOINT` … Die passenden Testserver (Python-Skripte) liegen in `crates/rc-core/tests/servers/`. Eine Anleitung steht in den Kopfkommentaren von `crates/rc-core/tests/ftp.rs` und `cloud.rs`.

Die Oberfläche lässt sich ohne Backend mit Testdaten ausprobieren: `npm --prefix ui run dev` und dann `http://localhost:5173/?mock=1` öffnen. `npm --prefix ui run test:unit` prüft Spracherkennung, JSON-Prüfung und Formatierer; `npm --prefix ui test` führt zusätzlich den Playwright-Smoke-Test der Oberfläche aus.

## Bekannte Einschränkungen

- **Google Cloud Storage** ist implementiert, aber nicht gegen einen echten Dienst getestet (alle anderen Protokolle sind mit echten Servern getestet: OpenSSH, pyftpdlib mit FTPS, WsgiDAV, S3-API von moto, Azurite).
- Object Stores (S3/Azure/GCS) können abgebrochene **Uploads** nicht fortsetzen und keine Zeitstempel oder Rechte setzen. Downloads lassen sich fortsetzen.
- WebDAV unterstützt nur Basic-Authentifizierung. SSH-Host-Zertifikate (CA) und vom Server erzwungene Passwortänderungen werden nicht unterstützt.
- Dateinamen, die kein gültiges UTF-8 sind, werden bei SFTP verlustbehaftet dargestellt.
- Die Windows- und macOS-Builds sind per Cross-Compile geprüft und über die CI abgedeckt, aber nicht manuell auf diesen Systemen getestet.

## Sicherheitshinweise

- Der Webmodus gewährt Zugriff auf das Dateisystem des Hosts mit den Rechten des Benutzers, unter dem `rcmd` läuft, standardmäßig auch auf eine Shell (`--no-terminal` schaltet das ab). Verwende ein starkes Passwort und HTTPS.
- Anmeldungen sind gegen Brute-Force gedrosselt. Sitzungen nutzen HttpOnly-/SameSite-Cookies, und alle schreibenden Anfragen sind gegen CSRF geschützt.
- Zum Formatieren startet Rust Commander nur bekannte Programme (`rustfmt`, `gofmt`, `ruff`, `black`, `shfmt`, `clang-format`, `taplo`, `stylua`) mit festen Argumenten in einem leeren temporären Ordner; der Text geht über die Standardeingabe.
- Gespeicherte Geheimnisse sind immer verschlüsselt. Ohne Master-Passwort liegt der Schlüssel in `vault.key` im Konfigurationsverzeichnis (nur für den Benutzer lesbar).

## Lizenz

MIT – siehe [LICENSE](LICENSE).
