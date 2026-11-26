# Vollständiger Abgleich offener Arbeiten

Stand: **2026-11-26**, Anwendung/Release **0.3.0**, geprüfter Quellstand
`6bbbde253384cb023a9a76050a5b4a0abe97c7a5`.

Abgeglichen wurden die vollständige [Produktspezifikation](PRODUCT.md), die
[Roadmap](ROADMAP.md), die Fachdokumentation, aktuelle Routen/Komponenten und die
zusätzlichen Anforderungen aus diesem Chat einschließlich der beiden Helm-/Storage-/OIDC-Aufträge. Die Liste erfasst die derzeit
feststellbaren fehlenden Umsetzungen, Ausbaugrenzen, ungeklärten Probleme und
noch ausstehenden Nachweise. Sie ist keine Liste bereits erledigter Features.

**Status:** **Fehlt** = keine entsprechende Implementierung; **Teilweise** = ein
funktionierender Teil existiert, der genannte Ausbau fehlt; **Nachweis offen** =
Diagnose oder belastbare Validierung fehlt; **Später/Optional** = ausdrücklich
verschobener oder zusätzlicher Umfang. Nicht jede dokumentierte Einschränkung
ist ein Fehler oder ein Muss für den frühen Server-Release.

**Umfang:** 136 einzeln nummerierte Punkte: 60 Fehlt, 45 Teilweise, 17 Nachweis offen, 5 Später, 9 Optional.

Der Release von 0.3.0 einschließlich Images/OCI-Chart ist erfolgreich
veröffentlicht. Die frühere fehlgeschlagene separate main-CI und die bei dir
ungeklärte Rancher-Anzeige werden unten unabhängig davon verfolgt. Die
ursprüngliche Produktions-Definition-of-Done ist durch den Server-Release noch
nicht vollständig erfüllt.

## Aktuelle Fehler und ungeklärte Installation

Befund aus diesem Chat und den [CI-Läufen](https://github.com/Lucas-Gruber/orvyn/actions).

- [ ] **001 · Nachweis offen:** Rancher: klären, warum bei dir weiterhin nur Chart 0.2.0 sichtbar ist beziehungsweise die Aktualisierungsaktion fehlt. 0.3.0 ist veröffentlicht und anonym aus GHCR abrufbar; Repository-Typ, Konfiguration und Rancher-Version sind noch ungeklärt.
- [ ] **002 · Nachweis offen:** Den fehlgeschlagenen Browser-Test zur Datenbank-Modalvorschau reproduzieren und die Ursache beheben. Der separate main-Lauf war rot, der vollständige Release-Lauf desselben Anwendungscodes grün; eine Ursache ist bislang nicht belegt.

## MCP und externe API-Nutzung

Grundlage: zusätzliche MCP-Anforderung im Chat, [API](API.md), [Produktspezifikation §19](PRODUCT.md#19-api-und-erweiterbarkeit).

- [ ] **003 · Fehlt:** Ein MCP-Server mit dokumentiertem, standardkonformem Transport und Client-Verbindungsablauf.
- [ ] **004 · Fehlt:** MCP-Werkzeuge zum Suchen und Lesen von Seiten sowie zum Erstellen/Aktualisieren von Seiten, Datenbanken und Datensätzen.
- [ ] **005 · Fehlt:** Authentifizierung, begrenzte Zugriffsrechte, Widerruf und Auditierung für MCP-/Integrationszugriffe unter den bestehenden Benutzer- und Ressourcenberechtigungen.
- [ ] **006 · Fehlt:** MCP-Konfiguration in Anwendung/Helm/Rancher sowie Integrations-, Berechtigungs- und Client-Kompatibilitätstests.
- [ ] **007 · Fehlt:** Eine dafür geeignete externe API-Authentifizierung jenseits der bisherigen Browser-Sitzung, einschließlich Verwaltung und Widerruf von Integrationsberechtigungen; das konkrete Verfahren ist noch zu entwerfen.
- [ ] **008 · Fehlt:** Generierte OpenAPI-Schemas und vollständige maschinenlesbare API-Dokumentation.

## Organisationen, Spaces und Identitäten

Belege: [Spaces-API](../apps/api/src/spaces.module.ts), [Space-Einstellungen](../apps/web/app/components/SpaceSettings.vue), [Authentifizierung](AUTHENTICATION.md), [Berechtigungen](PERMISSIONS.md).

- [ ] **009 · Fehlt:** Organisationen als eigenes Datenmodell mit Verwaltung, Mitgliedschaften und Zuordnung von Spaces.
- [ ] **010 · Fehlt:** Organisationsrollen, wiederverwendbare Benutzergruppen und deren Vererbung auf Ressourcen; passende Mandanten-/Organisationstrennungstests.
- [ ] **011 · Fehlt:** Eigentumsübertragung für Spaces beziehungsweise Organisationen.
- [ ] **012 · Fehlt:** Vollständige Space-Stammdatenverwaltung: nachträgliches Umbenennen und die spezifizierte Beschreibung; ein geregelter Verwaltungs-/Löschlebenszyklus fehlt ebenfalls.
- [ ] **013 · Fehlt:** Offene Einladungen administrativ auflisten und gezielt widerrufen; organisationsbezogene Einladungsrichtlinien.
- [ ] **014 · Fehlt:** OIDC-Gruppenzuordnung zu Rollen und Mitgliedschaften.
- [ ] **015 · Fehlt:** Explizite sichere Kontoverknüpfung und administrative Identitätszuordnung; gleiche E-Mail-Adressen werden bewusst nicht automatisch verknüpft.
- [ ] **016 · Teilweise:** SSO-Verfahren sind pro Provider schaltbar. Eine zentrale Administration aller Anmeldeverfahren einschließlich lokaler Passwortanmeldung fehlt; Registrierung abschalten ist eine eigene, bereits vorhandene Einstellung.
- [ ] **017 · Fehlt:** Provider-Logout beziehungsweise Single Logout und OIDC-Backchannel-Logout.
- [ ] **018 · Nachweis offen:** Reale zusätzliche Provider-/Deployment-Prüfungen, insbesondere Authentik und Entra ID. Keycloak und signierte Authentik-typische Protokollfälle sind bereits getestet.

## Instanzadministration

Derzeit gibt es insbesondere Account-, Space-Mitglieder- und OIDC-Oberflächen; Grundlage ist [Produktspezifikation §13.3](PRODUCT.md#133-admin-oberfläche).

- [ ] **019 · Fehlt:** Ein vollständiges zentrales Admin-Dashboard.
- [ ] **020 · Fehlt:** Instanzweite Benutzerverwaltung mit administrativen Rollen- und Kontolebenszyklusfunktionen; die bestehende persönliche Account-/Sessionverwaltung ersetzt diese nicht.
- [ ] **021 · Fehlt:** Zentrale Organisations-/Space-Übersicht und dazugehörige Verwaltungsabläufe.
- [ ] **022 · Fehlt:** Eine Instanzoberfläche für Sicherheits- und Freigaberichtlinien.
- [ ] **023 · Fehlt:** Storage-Einstellungen über die Admin-Oberfläche; Deployment-Konfiguration existiert bereits.
- [ ] **024 · Fehlt:** SMTP-/E-Mail-Einstellungen über die Admin-Oberfläche.
- [ ] **025 · Fehlt:** Systeminformationen und Betriebszustand in der Administration.
- [ ] **026 · Fehlt:** Eine Oberfläche für Sicherheits-Audit-Logs mit geeigneten Filtern und Auswertung; Audit-Ereignisse werden bereits gespeichert.

## White-Labeling und Erscheinungsbild

Grundlage: [Produktspezifikation §13](PRODUCT.md#13-white-labeling-und-branding), [Seiten-/Space-Erscheinungsbild](PAGE_APPEARANCE.md).

- [ ] **027 · Fehlt:** Instanzbranding ohne Codeänderungen: Plattformname, Logo, Favicon, Beschreibung, Tagline, Primär-/Akzentfarben und Login-Seite.
- [ ] **028 · Fehlt:** Administrativ konfigurierbare Standard-Sprache und Standardtheme.
- [ ] **029 · Fehlt:** Branding für öffentliche Seiten sowie Absendername und anpassbare E-Mail-Vorlagen.
- [ ] **030 · Optional:** Organisationsbranding mit eigener Identität/Logos/Farben, getrennt von Instanz- und Space-Einstellungen.
- [ ] **031 · Teilweise:** Space-Erscheinungsbild ausbauen: hochgeladene Space-Cover, Zuschnitt/Fokuspunkt und freie Cover-/Space-Farben. Emoji-Icons, Preset-Cover und private Bild-Cover für Seiten sind vorhanden.

## Seiten, Editor und Navigation

Belege: [Blocksteuerung](BLOCK_CONTROLS.md), [Seitenhierarchie](PAGE_HIERARCHY.md), [Mentions](EDITOR_MENTIONS.md), [Vorschaukarten](PAGE_PREVIEWS.md), [Workspace-UI](UI.md).

- [ ] **032 · Fehlt:** Vorlagen für normale Seiten, wiederverwendbare Seiteninhalte und ein Vorlagenpicker beim Erstellen.
- [ ] **033 · Teilweise:** Neue Unterseiten direkt aus dem Editor beziehungsweise per eigenem Slash-Befehl erstellen. Seitenhierarchie, Sidebar-Erstellung und Referenz-/Vorschaukarten sind vorhanden.
- [ ] **034 · Fehlt:** Vorschaukarten für beliebige externe Webseiten; interne Seiten-/Überschriftenkarten und ausgewählte Video-Embeds existieren.
- [ ] **035 · Teilweise:** Einzelne Listeneinträge und Tabellenzeilen unabhängig mit den allgemeinen Block-Verschiebeaktionen umstrukturieren; derzeit bewegen sich Listen/Tabellen dabei als ganze Blöcke.
- [ ] **036 · Fehlt:** Eine globale Aktionspalette über die vorhandene Seitensuche und Shortcut-Hilfe hinaus.
- [ ] **037 · Fehlt:** Space-übergreifendes Verschieben von Seiten/Hierarchien mit Erhalt beziehungsweise geprüfter Neuabbildung von Referenzen und Berechtigungen.
- [ ] **038 · Teilweise:** Papierkorb um endgültiges Löschen und nachvollziehbare Aufbewahrungsregeln für Seiten ergänzen.
- [ ] **039 · Teilweise:** Nutzbare automatische Wiederherstellung legitimer, zurückgewiesener Mention-/Dokumentänderungen bei einem gleichzeitigen Rechtewechsel. Derzeit kann Kopieren/Neuladen nötig sein.
- [ ] **040 · Teilweise:** Vorschaukarten sowie Titel-/Appearance-Metadaten ohne manuelles Refresh/Neuladen zwischen Ansichten aktuell halten.

## Datenbanken

Belege: [Formeln](DATABASE_FORMULAS.md), [Rollups](DATABASE_ROLLUPS.md), [Vorlagen](DATABASE_TEMPLATES.md), [Relationen](RECIPROCAL_RELATIONS.md), [Typkonvertierung](PROPERTY_CONVERSION.md), [Kanban](KANBAN.md).

- [ ] **041 · Teilweise:** Typkonvertierung über die bisherigen skalaren Typen hinaus; größere, kontrollierte Batches über die aktuelle 5.000-Record-Grenze.
- [ ] **042 · Teilweise:** Datenbank-/Datensatzvorlagen zwischen Spaces übertragen.
- [ ] **043 · Fehlt:** Automatische Standardvorlagen für neue Datensätze.
- [ ] **044 · Teilweise:** Bestehende befüllte einseitige Relationen in passende zweiseitige Beziehungen umwandeln beziehungsweise vorhandene Felder sicher neu verbinden.
- [ ] **045 · Teilweise:** Datum-/Zeitberechnungen und zeitabhängige Funktionen in Formeln; Listen als Formelergebnis fehlen ebenfalls.
- [ ] **046 · Teilweise:** Rollups über mehr als zwei Relationsschritte, weitergehende pfadabhängige Formeln, Originalwert-Arrays und Datums-Extrema.
- [ ] **047 · Teilweise:** Erweiterte Gruppierung, insbesondere Kalender-Gruppierung und weitere Gruppierfeldtypen jenseits Status/Select.
- [ ] **048 · Teilweise:** Manuelle Kartenreihenfolge innerhalb einer Kanban-Spalte unabhängig von der gespeicherten Sortierung.
- [ ] **049 · Teilweise:** Änderungen an Relations-/Formel-/Rollup-Zielen müssen auch neue Treffer außerhalb der gerade geladenen Ergebnisse zuverlässig in gefilterte Ansichten bringen; aktuell kann Refresh nötig sein.
- [ ] **050 · Teilweise:** Fehlgeschlagene Zell-/Record-Entwürfe über Reload/Browserabsturz hinaus behalten; aktuell liegen sie im Arbeitsspeicher.

## Suche

Belege: [Suchumfang](SEARCH.md).

- [ ] **051 · Teilweise:** Suche in berechneten und referenzierten Properties, Personen-/Identitätsmetadaten und Dateiinformationen unter den jeweils aktuellen Berechtigungen.
- [ ] **052 · Teilweise:** Suche auf Kommentare, Dateiinhalte und historische Revisionen erweitern; diese Inhalte sind derzeit nicht Teil des Index.
- [ ] **053 · Teilweise:** Erweiterte Suchsemantik: Phrasen, unscharfe Suche, beliebige Teilstrings in Property-Werten und sprachabhängige Wortstammsuche.

## Kommentare, Benachrichtigungen und Aktivität

Belege: [Kommentare](COMMENTS.md), [Benachrichtigungen](NOTIFICATIONS.md), [Aktivität](ACTIVITY.md).

- [ ] **054 · Teilweise:** Direktlinks zu einzelnen Diskussionen/Threads.
- [ ] **055 · Teilweise:** Rich-Text-Formatierung und Anhänge in Kommentaren.
- [ ] **056 · Teilweise:** Kommentarentwürfe dauerhaft statt ausschließlich im Arbeitsspeicher halten.
- [ ] **057 · Fehlt:** Benachrichtigungspräferenzen, Stummschalten und Folgen/Abonnieren.
- [ ] **058 · Teilweise:** Gespeicherte Aktivitätsfilter und Abonnements.
- [ ] **059 · Optional:** Detail-Diffs je Feld und historische Namen-/Titel-Snapshots im Aktivitätsverlauf; die heutige Timeline löst sichtbare Bezeichnungen aktuell auf.

## Whiteboards

Belege: [Whiteboards](WHITEBOARDS.md).

- [ ] **060 · Teilweise:** Kamera-/Zoomposition dauerhaft wiederherstellen.
- [ ] **061 · Teilweise:** Formen-/Bibliothekssammlungen serverseitig synchronisieren.
- [ ] **062 · Teilweise:** CRDT-/Tombstone-Kompaktierung und länger laufende Konflikt-/Lasttests.
- [ ] **063 · Teilweise:** Aussagekräftigere Whiteboard-Textvorschauen in allgemeinen Seitenkarten.

## Öffentliche Freigaben

Belege: [Public Sharing](PUBLICATIONS.md).

- [ ] **064 · Teilweise:** Konfigurierbare beziehungsweise gebrandete öffentliche Darstellung.
- [ ] **065 · Fehlt:** Eigene Domains für öffentliche Veröffentlichungen.
- [ ] **066 · Teilweise:** Social-Sharing-Vorschauen um passende Vorschaubilder erweitern.

## Sprache und persönliche Einstellungen

Grundlage: [Produktspezifikation §15](PRODUCT.md#15-internationalisierung-und-einstellungen), [Workspace-UI](UI.md).

- [ ] **067 · Fehlt:** Deutsch, Englisch und Systemsprache mit vollständigem Wechsel zur Laufzeit.
- [ ] **068 · Fehlt:** Durchgängige sprachabhängige Oberflächentexte und Datums-/Zahlenformate ohne Übersetzung von Benutzerinhalten oder technischen IDs.
- [ ] **069 · Fehlt:** Ein echter Schriftgrößenregler beziehungsweise persönliche Typografie-Einstellung.
- [ ] **070 · Teilweise:** Accountweite Synchronisation von Darstellung, Favoriten/Zuletzt verwendet und weiteren Präferenzen bei weiterhin möglichen Geräte-Overrides.
- [ ] **071 · Fehlt:** Eine vollständige Programminfo-/Versionsansicht und zusammenhängende Einstellungsoberfläche; Account-, Session- und Theme-Funktionen sind vorhanden.

## Dateien und Storage

Belege: [Dateien](FILES.md), [Storage](STORAGE.md).

- [ ] **072 · Teilweise:** PDF-/Office-Dateivorschauen über die vorhandenen Bildvorschauen und Downloads hinaus.
- [ ] **073 · Teilweise:** Weitergehende Bildprüfung und Bildoptimierung.
- [ ] **074 · Teilweise:** Malwareprüfung für hochgeladene Dateien.
- [ ] **075 · Fehlt:** Eine Oberfläche zum Wiederherstellen gelöschter Anhänge während ihrer Aufbewahrung.
- [ ] **076 · Fehlt:** Ein geprüftes automatisches Migrationswerkzeug zwischen Dateisystem- und S3-Storage beziehungsweise Installationen; Treiberwechsel allein migriert keine Daten.

## Import, Export und Migration

Belege: [Markdown-Archive](MARKDOWN_BUNDLES.md), [Datenbanktransfer](DATABASES.md), [Produktspezifikation §18](PRODUCT.md#18-import-und-export).

- [ ] **077 · Teilweise:** Ganze Seitenhierarchien einschließlich Anhängen importieren.
- [ ] **078 · Fehlt:** Portabler nativer JSON-Import/Restore mit Schema-, Identitäts-/Referenz- und Dateizuordnung.
- [ ] **079 · Teilweise:** Vollständige portable Pakete über sämtliche betreffenden Seiten-/Datenbank-/Whiteboard-Inhalte und Dateibytes; bestehende JSON-Exporte sind kein vollständiges Wiederherstellungsformat.
- [ ] **080 · Fehlt:** Ein verlässlicher Notion-Importer für Seiten, Datenbanken, Properties und Anhänge.
- [ ] **081 · Optional:** CSV-Upsert beziehungsweise Aktualisierung bestehender Datensätze und Erstellen neuer Relationsschemas aus unkonfigurierten CSV-Spalten. Der bestehende Import legt neue Records an.

## Betrieb und Sicherheit

Grundlage: [Produktspezifikation §20](PRODUCT.md#20-kubernetes-und-self-hosting), [Security](../SECURITY.md), [Authentifizierung](AUTHENTICATION.md).

- [ ] **082 · Fehlt:** Prometheus-kompatible Betriebsmetriken; strukturierte Logs und Health Checks sind vorhanden.
- [ ] **083 · Fehlt:** OpenTelemetry-kompatible Tracing-Instrumentierung.
- [ ] **084 · Fehlt:** Passende Betriebsdashboards und Alarmierung.
- [ ] **085 · Teilweise:** Vertrauenswürdige Proxy-Ketten und nutzerbezogene IP-Erkennung für Rate Limits definieren und testen; hinter dem aktuellen Web-Proxy teilen Benutzer dessen IP-Limit.
- [ ] **086 · Teilweise:** Eine vollständige, getestete Security-Header-Policy für Web/API/Public einschließlich Deployment-Zuständigkeit für HSTS/CSP; einzelne Header und spezielle Datei-/Diagramm-Sandboxen existieren.
- [ ] **087 · Fehlt:** Geeignete optionale Netzwerksegmentierung/NetworkPolicies für die Komponenten.
- [ ] **088 · Fehlt:** Werkzeuge zur sicheren Rotation des Anwendungsschlüssels einschließlich Neuverschlüsselung betroffener Daten.
- [ ] **089 · Teilweise:** Betriebliche Aufbewahrungs-/Datenschutzregeln für Audit- und Betriebsdaten festlegen.
- [ ] **090 · Nachweis offen:** Produktive S3-/Object-Storage-Konfigurationen mit passenden IAM-/Bucket-, TLS-, Verschlüsselungs- und Retention-Regeln validieren.
- [ ] **091 · Nachweis offen:** Hochverfügbarkeit, Ausfall-/Wiederanlaufverhalten und Betriebsgrenzen unter Produktivlast belegen. Die interne PostgreSQL-/Valkey-/SeaweedFS-Topologie ist jeweils single-instance.

## Backups und vollständige Wiederherstellung

Belege: [Backup und Recovery](BACKUP.md).

- [ ] **092 · Teilweise:** Geplante, konsistente Sicherungen der Anhänge beziehungsweise S3-/Dateisystemdaten passend zum Datenbankzeitpunkt.
- [ ] **093 · Teilweise:** Schlüssel und Secrets getrennt und koordiniert in die Wiederherstellung einbeziehen.
- [ ] **094 · Fehlt:** Verschlüsselte externe/offsite Sicherungen mit Aufbewahrung und geprüfter Rücksicherung.
- [ ] **095 · Teilweise:** Produktives Point-in-Time-Recovery über die bisherigen PostgreSQL-Snapshots hinaus.
- [ ] **096 · Nachweis offen:** Eine komplette isolierte Kubernetes-Wiederherstellungsübung mit Datenbank, Dateien, Schlüssel, OIDC, Worker und Collaboration; vorhandene Teil-Restores sind bereits getestet.
- [ ] **097 · Nachweis offen:** Wiederherstellungsdauer für große Datenbestände sowie belastbare RPO-/RTO-Ziele bestimmen.

## Qualitäts- und Produktionsnachweise

Belege: [Deployment-Prüfbericht](DEPLOYMENT-HARDENING.md), [UI](UI.md), [CI](../.github/workflows/ci.yml).

- [ ] **098 · Nachweis offen:** Echte TrueNAS-/Democratic-CSI-/NFS-Tests einschließlich Root Squashing, ACLs und Mehrknoten-RWX-Betrieb. Bisherige Named-Volume-/Denied-chown-Fixtures sind keine realen NFS-Nachweise.
- [ ] **099 · Nachweis offen:** Reale Longhorn-, k3s-local-path- und weitere CSI-/RWO-/Existing-PVC-Szenarien gegen die zugesagte Backend-Matrix prüfen.
- [ ] **100 · Nachweis offen:** RKE2-/k3s-Betrieb und tatsächliche Ingress-/TLS-/cert-manager-/WSS-Konfigurationen außerhalb der lokalen HTTPS-Fixture und des Kind-Testclusters prüfen.
- [ ] **101 · Nachweis offen:** Echte Rancher-, Argo-CD- und Flux-Installations-/Upgrade-/Rollback-Abläufe prüfen; gerenderte GitOps-Konfigurationen und Helm-CLI-Tests allein belegen noch keine erfolgreiche Bedienung dieser Systeme.
- [ ] **102 · Nachweis offen:** Lasttests für große Hierarchien, große Datenbanken/Relationsgraphen, Suchindex-Rebuilds und viele gleichzeitige Kollaborationsbenutzer; daraus Leistungsziele und nötige Virtualisierung ableiten.
- [ ] **103 · Nachweis offen:** Einen vollständigen UI-/UX-Abnahmedurchlauf mit aktuellen Bildern und realen Arbeitsabläufen durchführen: Orientierung, konsistente Abstände/Trennlinien, Dialoge/Slide-outs, leere Tabellen, Lade-/Fehlerzustände, kontextbezogene Aktionen und responsive Bedienung. Die bereits implementierten UI-Überarbeitungen belegen noch keine durchgehende Produktqualität nach dem gewünschten Notion-Maßstab.
- [ ] **104 · Nachweis offen:** Vollständiger Tastatur-, Screenreader- und Barrierefreiheits-Audit einschließlich Canvas und Touch.
- [ ] **105 · Nachweis offen:** Breitere Browser-/Betriebssystemprüfung, insbesondere Firefox, Safari/WebKit, Edge sowie echtes Windows/macOS; die bisherigen Browserläufe verwenden Chromium unter Linux.
- [ ] **106 · Nachweis offen:** Umfassender Sicherheits-/Penetrationstest und später Organisationsgrenzen über sämtliche Zugriffspfade prüfen.
- [ ] **107 · Teilweise:** Die geforderten isolierten UI-Komponententests sowie explizite Source-Lint-/Format-Checks in CI ergänzen. Typechecks, Node-Tests, Browser-, Helm- und Release-Tests existieren.
- [ ] **108 · Nachweis offen:** Langzeit-/Upgrade- und Wiederanlaufprüfungen für echte Produktionsdaten durchführen; gemischte Editor-Schemas beim Rolling Upgrade sind derzeit kein unterstützter Upgradeweg.

## Desktop-Clients und Auslieferung

Grundlage: [Produktspezifikation §§3.2 und 22](PRODUCT.md#32-desktop), [Release-Prozess](../RELEASE.md).

- [ ] **109 · Fehlt:** Funktionierende Tauri-2-/Rust-Anwendungen für Windows, macOS und Linux mit gemeinsam genutzter UI/Businesslogik und konfigurierbarer Serveradresse.
- [ ] **110 · Fehlt:** Stabile Reverse-DNS-App-ID/Paketidentität, abgesicherte IPC- und native Systemintegration, sicherer lokaler Credential-Speicher, Deep Links und Desktop-Benachrichtigungen.
- [ ] **111 · Fehlt:** Native Anmeldung über Systembrowser und geeigneten OAuth-/PKCE-Flow.
- [ ] **112 · Fehlt:** Windows-Artefakte: portable EXE und NSIS-Setup-EXE.
- [ ] **113 · Fehlt:** macOS-Artefakte: APP-ZIP und DMG.
- [ ] **114 · Fehlt:** Linux-Artefakte: AppImage, DEB und Flatpak sowie Flatpakref für stabile Releases; tatsächliche Architektur und Version in Dateinamen.
- [ ] **115 · Fehlt:** Gemeinsame Versionierung von Node-, Tauri- und eigenen Cargo-Paketen/Cargo.lock. Die vorhandene Server-Versionierung enthält noch keinen Desktop-Client.
- [ ] **116 · Fehlt:** Native Build-/Test-/Release-Matrix mit unveränderlichen Installern, Prüfsummen, Signaturen, Release Notes und Update-Metadaten; echte Plattform-, IPC- und Installationsprüfungen.
- [ ] **117 · Fehlt:** Desktop-Updater: Prüfung bei Start/Fokus/manuell, Release Notes, Fortschritt, Fehlerbehandlung und ausdrückliche Zustimmung vor Download/Installation.
- [ ] **118 · Fehlt:** Installationsartgerechte Updates mit HTTPS-, Versions-, Integritäts- und Signaturprüfung, Downgrade-Schutz sowie Trennung von Stable/Prerelease.
- [ ] **119 · Fehlt:** Tauri-Updater-Signierung; separate Windows-Authenticode- und Apple-Codesigning-/Notarisierungsabläufe mit geschützter Schlüsselverwaltung.
- [ ] **120 · Fehlt:** Flatpak-/Portal-konforme Updates und Paketquellen-/Berechtigungsbehandlung; keine Installation anderer Pakettypen über den Flatpak-Updateweg.
- [ ] **121 · Fehlt:** Trennung dynamischen Serverbrandings von stabiler installierter App-Identität; eigene Builds/Signierung für individuell gebrandete Installer.

## Dokumentation und Projektgrundlagen

Belege: [API](API.md), [Architektur](../ARCHITECTURE.md), [Security](../SECURITY.md), Repository-Dateibestand.

- [ ] **122 · Teilweise:** API-, Architektur- und Statusdokumente mit dem tatsächlichen Stand abgleichen: einige alte Texte führen bereits implementierte Kommentare, Mentions, verschachtelte Blockaktionen, Spaltenbreiten oder zweistufige Rollups noch als offen.
- [ ] **123 · Fehlt:** Eine ausdrückliche Projektlizenz als LICENSE-Datei auswählen und beilegen. Drittanbieter-/Schriftlizenzen liegen bereits unter apps/web/public/licenses; eine eigene Projektlizenz ist im Repository nicht vorhanden.
- [ ] **124 · Teilweise:** Einen konkreten vertraulichen Sicherheitsmeldeweg/Kontakt festlegen.
- [ ] **125 · Teilweise:** Neue Architekturentscheidungen zu Organisationen, MCP, Branding und Desktop dokumentieren; bestehende Entwicklungs-, Deployment- und Release-Dokumente sind vorhanden.

## Ausdrücklich spätere beziehungsweise optionale Erweiterungen

Die Spezifikation verschiebt diese Punkte oder bezeichnet sie als optional; sie sind keine stillschweigende Verpflichtung für jeden frühen Server-Release.

- [ ] **126 · Später:** Native iOS-/Android-Apps mit mobiler Authentifizierung, späteren Push-Nachrichten und Offline-Sync; keine initiale Priorität.
- [ ] **127 · Später:** Vollwertiges Browser-Offline-Editing mit dauerhaftem lokalen Speicher und sicherem Resync. Aktuell pausiert Bearbeitung bei Verbindungs-/Rechteverlust.
- [ ] **128 · Später:** SAML-Anbindung; OIDC ist bereits vorhanden.
- [ ] **129 · Später:** Timeline-Ansicht für Datenbanken.
- [ ] **130 · Später:** Externe Webhooks, Automatisierungs-/Integrationsschnittstellen und Plugin-Erweiterungspunkte. Eine komplexe allgemeine Plugin-Runtime war für die erste Version ausdrücklich nicht gefordert.
- [ ] **131 · Optional:** E-Mail-Benachrichtigungen sowie Push-/Offline-Zustellung der Inbox.
- [ ] **132 · Optional:** System-Tray für Desktop.
- [ ] **133 · Optional:** Eigene signierte Flatpak-/OSTree-Paketquelle mit GPG, Flatpakref/Flatpakrepo, möglichst über GitHub Pages.
- [ ] **134 · Optional:** Native Touch-Drag-Gesten für Seitenhierarchie, Kanban und Editor-Tabellenspalten; alternative Menüs und mobile Bedienung existieren.
- [ ] **135 · Optional:** Marquee-/Rahmenauswahl im Editor, unabhängiges Umordnen von Editor-Tabellenzeilen und Spreadsheet-Formeln in einfachen Editor-Tabellen.
- [ ] **136 · Optional:** Weitere Video-/Embed-Anbieter und private Provider-Videos; echte Wiedergabe gegen die bereits unterstützten externen Anbieter ist separat zu validieren.

## Bereits umgesetzt und deshalb nicht erneut als fehlend geführt

OIDC-Anmeldung und Konfiguration, lokale Accounts/Sessions, SSO-Einladungen,
Anzeigenamen, aktuelle Space-/Seiten-/Record-/Datei-/Whiteboard-Berechtigungen,
Kommentare/Mentions, Live-Cursors und Presence auch für Whiteboards,
Live-Collaboration, H1–H4, Slash Commands, Markdown-Paste, Dokument-/Heading-Links,
verschachtelte Blockaktionen, Tabellenmenüs und Desktop-Spaltenresize,
zweistufige Rollups, Datenbank-/Datensatzvorlagen, fünf Datenbankansichten,
Kanban-Bewegung zwischen Gruppen, Mermaid, Excalidraw, geprüfte öffentliche
Snapshots, CSV/JSON-/Markdown-Exporte, ausgewählte Markdown-Hierarchiearchive,
PostgreSQL-Snapshots/isolierte Teil-Restores, sieben Themes, lokal ausgelieferte
Fonts/Lizenztexte und die signierte Server-/Helm-Release-Pipeline sind vorhanden.

Sicherheitsgrenzen wie keine beliebigen ausführbaren HTML-Embeds, keine
E-Mail-basierte automatische Kontoverknüpfung, keine automatische Abschaltung
von NFS Root Squashing und keine unbeschränkten Dokument-/Graphgrößen bleiben
bewusste Grenzen; sie sind keine Aufforderung, Schutzmaßnahmen zu entfernen.
