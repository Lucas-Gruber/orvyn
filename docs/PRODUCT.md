# ORVYN — MASTER DEVELOPMENT PROMPT

**Product:** Orvyn  
**Tagline:** Your knowledge. Organized.  
**Product category:** Collaborative knowledge management and workspace platform  
**Primary deployment:** Self-hosted Kubernetes web application  
**Desktop application:** Tauri 2  
**Future platforms:** iOS and Android  
**Development objective:** Production-ready, modular, secure, extensible, open-source-friendly platform

---

# 1. Rolle und übergeordnetes Ziel

Du bist ein erfahrener Principal Software Architect, Full-Stack Engineer, UX/UI Designer, DevOps Engineer und Security Engineer.

Entwickle **Orvyn**, eine moderne, kollaborative Knowledge-Management- und Workspace-Plattform.

Orvyn soll sich hinsichtlich Funktionalität, Benutzerfreundlichkeit und Arbeitsabläufen stark an Notion orientieren, jedoch eine eigenständige visuelle Identität und technische Architektur besitzen.

Die Plattform vereint:

- Dokumente und Notizen
- Hierarchische Seiten und Ordner
- Persönliche Workspaces
- Gemeinsame Team-Spaces
- Strukturierte Datenbanken
- Datenbankansichten einschließlich Tabellen, Kanban, Kalender, Galerie und Listen
- Whiteboards und Diagramme
- Live Collaboration
- Wissensdatenbanken und Wikis
- Öffentlich freigegebene Inhalte
- Benutzer- und Berechtigungsverwaltung
- Single Sign-On
- White-Labeling
- Anpassbare Themes
- Web- und Desktop-Clients

Die Nutzung soll gleichermaßen für Einzelpersonen, Entwickler, Unternehmen und größere Teams geeignet sein.

**Produktidentität:**

- Name: `Orvyn`
- Schreibweise im Branding: `orvyn.`
- Tagline: `Your knowledge. Organized.`
- Technischer Projektname: `orvyn`
- Repository und GitHub-Owner: aus vorhandener Repository-Konfiguration ermitteln, andernfalls konfigurierbar halten
- App-ID: eine stabile Reverse-DNS-ID in der Projektkonfiguration definieren
- Standard-Edition: Self-hosted

Verwende ausschließlich die Identität von Orvyn. Übernimm keine internen Bezeichnungen, IDs, Konfigurationsschlüssel oder Marken aus anderen Projekten.

# 2. Grundprinzipien

Die folgenden Anforderungen sind verbindlich.

1. **Web-first:** Die Web-App ist ein vollwertiger Client und nicht nur eine Vorschau der Desktop-App.
2. **Self-hosted-first:** Alle Kernfunktionen müssen in einer eigenen Kubernetes-Umgebung funktionieren.
3. **Privacy-first:** Neue Spaces und deren Inhalte sind standardmäßig privat.
4. **Collaboration-first:** Gleichzeitiges Bearbeiten ist ein Kernbestandteil der Architektur.
5. **Modularität:** Editor, Datenbanken, Spaces, Whiteboards und Benutzerverwaltung müssen sauber voneinander getrennt sein.
6. **Platform consistency:** Browser und Desktop verwenden soweit sinnvoll dieselben UI-Komponenten und dieselbe Businesslogik.
7. **API-first:** Sämtliche wesentlichen Funktionen müssen über dokumentierte APIs zugänglich sein.
8. **Security by design:** Zugriffskontrollen werden serverseitig erzwungen.
9. **White-label-ready:** Branding ist über eine Admin-Oberfläche konfigurierbar und nicht im Quellcode fest verdrahtet.
10. **Future-ready:** Mobile Apps, zusätzliche Integrationen und weitere Authentifizierungsverfahren müssen später möglich sein.
11. **Production readiness:** Keine Mockdaten oder simulierten Funktionen als fertig implementierte Features ausgeben.
12. **Eigenständigkeit:** Notion dient als funktionale und UX-bezogene Referenz. Kein Kopieren geschützter Icons, Marken, proprietärer Designs oder Quellcodes.

Bevorzugt werden langfristig wartbare Technologien gegenüber experimentellen oder unnötig komplexen Lösungen.

# 3. Technologie und Architektur

## 3.1 Frontend

Verwende bevorzugt:

- Nuxt mit Vue 3
- TypeScript
- Composition API
- Nuxt UI als Komponentenbasis
- Tailwind CSS
- Pinia für geeigneten Client-State
- VueUse
- ProseMirror-basierter Editor, bevorzugt Tiptap
- Yjs für kollaborative Dokumentzustände
- Wiederverwendbare UI-Komponenten und Composables

Die konkrete Auswahl der aktuellen stabilen und kompatiblen Bibliotheksversionen muss überprüft und dokumentiert werden.

Nutze Nuxt sowohl für die eigentliche Web-App als auch für sinnvoll serverseitig gerenderte öffentliche Freigabeseiten.

Implementiere eine konsistente App-Shell für Navigation, Spaces, Suche, Editor, Datenbanken, Einstellungen und Administration.

## 3.2 Desktop

Erstelle eine Desktop-Anwendung mit:

- Tauri 2
- Rust stable
- WebView-basierter Oberfläche
- Gemeinsamem Vue-Komponenten- und Editor-Code
- Plattformgerechten nativen Integrationen
- Gesichertem lokalem Credential-Storage
- Desktop-Benachrichtigungen
- Deep Links
- Optionalen System-Tray-Funktionen
- Signierten Anwendungsupdates

Die Desktop-App verbindet sich mit einem konfigurierbaren Orvyn-Server.

Es darf keine zweite, unabhängige Geschäftslogik für den Desktop entstehen.

Der gemeinsame UI-Code muss sowohl in einer Nuxt-Web-Anwendung als auch in der Tauri-Anwendung nutzbar sein.

Falls Nuxt SSR nicht sinnvoll innerhalb von Tauri betrieben werden kann, verwende für die Desktop-Shell einen kompatiblen Client-Build mit gemeinsam genutzten Komponenten und Composables.

## 3.3 Backend

Verwende bevorzugt:

- Node.js 22 oder neuer
- TypeScript
- NestJS als modularen Backend-Kern
- REST API mit OpenAPI-Dokumentation
- WebSockets für Echtzeitkommunikation
- PostgreSQL als primäre Datenbank
- Redis für geeignete kurzlebige Zustände, Queues und verteilte Koordination
- S3-kompatiblen Object Storage
- Separate Worker-Prozesse für Hintergrundaufgaben

Prüfe diese Auswahl gegen aktuelle Kompatibilität und Projektanforderungen.

Beginne mit einem **modularen Monolithen für die Business-API** statt unnötig viele Microservices zu erstellen.

Physisch getrennte Deployments sind für folgende Komponenten sinnvoll:

- Web Frontend
- API Backend
- Collaboration Service
- Background Worker
- PostgreSQL
- Redis
- Object Storage

Der Collaboration Service kann separat skalieren, muss aber dieselbe Authentifizierungs- und Berechtigungslogik verwenden wie das Hauptbackend.

Implementiere klare Modulgrenzen für:

- Authentication
- Users
- Organizations
- Spaces
- Permissions
- Pages
- Editor Documents
- Databases
- Database Views
- Collaboration
- Comments
- Search
- Files
- Sharing
- Whiteboards
- Notifications
- Branding
- Administration
- Audit Logs

## 3.4 Monorepo

Verwende pnpm Workspaces mit einem klaren Monorepo-Aufbau, beispielsweise:

```text
orvyn/
├── apps/
│   ├── web/
│   ├── desktop/
│   ├── api/
│   ├── collaboration/
│   └── worker/
├── packages/
│   ├── ui/
│   ├── editor/
│   ├── shared/
│   ├── api-client/
│   ├── auth/
│   ├── design-tokens/
│   └── config/
├── infrastructure/
│   ├── docker/
│   ├── helm/
│   └── compose/
├── docs/
├── scripts/
└── .github/
```

Die Struktur darf angepasst werden, wenn eine nachweislich sinnvollere Lösung existiert.

Begründe wichtige Architekturentscheidungen in Architecture Decision Records.

# 4. Identity, Authentication und SSO

Orvyn muss über ein eigenständiges Authentifizierungs- und Autorisierungsmodell verfügen.

## 4.1 Authentifizierung

Unterstütze:

- Lokale Benutzerkonten
- Sichere Passwort-Authentifizierung
- Passwortzurücksetzung
- E-Mail-Verifizierung
- Sitzungsverwaltung
- Logout einzelner und aller Sitzungen
- OIDC Single Sign-On
- OAuth 2.0 / OpenID Connect über externe Identity Provider

Die Architektur soll SAML 2.0 später ermöglichen, ohne das gesamte Identitätsmodell neu entwickeln zu müssen.

Geeignete OIDC-Provider sind beispielsweise Authentik, Keycloak, Microsoft Entra ID oder andere standardkonforme Systeme.

## 4.2 SSO-Administration

Administratoren müssen über die Oberfläche:

- OIDC-Provider hinzufügen
- Client-ID und Client-Secret konfigurieren
- Issuer URL hinterlegen
- Redirect-URLs einsehen
- Scopes konfigurieren
- Benutzerzuordnung festlegen
- Automatische Benutzeranlage aktivieren oder deaktivieren
- Gruppen-Mapping verwalten
- Login-Verfahren aktivieren oder deaktivieren können

Secrets werden ausschließlich verschlüsselt beziehungsweise in einer geeigneten Secret-Verwaltung gespeichert.

## 4.3 Session Security

Implementiere:

- Sichere HttpOnly-Cookies für Browser-Sitzungen
- CSRF-Schutz bei cookiebasierten mutierenden Requests
- Geeignete SameSite-Einstellungen
- Schutz gegen Session Fixation
- Token-Rotation, wo angemessen
- Sichere Desktop-Authentifizierung über Systembrowser und geeigneten OAuth-Flow
- PKCE für öffentliche OAuth-Clients
- Rate Limiting
- Auditierung sicherheitsrelevanter Ereignisse

Keine langfristigen Zugangstokens ungeschützt im Browser Local Storage speichern.

# 5. Organisationen, persönliche Spaces und Team-Spaces

Die Space-Architektur gehört zu den wichtigsten Funktionen.

## 5.1 Grundmodell

Ein Benutzer kann mehrere Spaces besitzen beziehungsweise Mitglied mehrerer Spaces sein.

Jeder Space besitzt:

- Eine eindeutige ID
- Einen Namen
- Eine Beschreibung
- Ein Icon
- Optional ein Cover
- Einen Besitzer oder eine verwaltende Organisation
- Mitglieder
- Rollen und Berechtigungen
- Seiten
- Datenbanken
- Whiteboards
- Dateien
- Einstellungen

## 5.2 Privacy by Default

**Jeder neu erstellte Space ist standardmäßig privat.**

Neue Seiten, Datenbanken, Ordner und Whiteboards dürfen niemals automatisch öffentlich erreichbar sein.

Ein persönlicher Space ist zunächst ausschließlich für seinen Besitzer zugänglich.

## 5.3 Persönliche Spaces

Benutzer können mehrere private Spaces anlegen.

Beispiele:

- Personal
- Knowledge Base
- Development
- Projects
- Documentation

Persönliche Spaces können vollständig privat bleiben oder gezielt geteilt werden.

## 5.4 Team-Spaces

Ein persönlicher Space kann bei Bedarf durch einen ausdrücklich bestätigten Vorgang in einen gemeinsamen Team-Space umgewandelt werden.

Unterstütze:

- Benutzer einladen
- Bestehende Mitglieder verwalten
- Rollen vergeben
- Eigentümer wechseln
- Mitglieder entfernen
- Teams beziehungsweise Organisationen anlegen
- Spaces einer Organisation zuweisen
- Gemeinsame Navigation
- Gemeinsame Inhalte
- Mitgliederübersicht
- Aktivitätsverlauf

Die Umwandlung darf bestehende private Inhalte nicht unbeabsichtigt für neue Mitglieder freigeben.

Biete dafür eine Vorschau der resultierenden Berechtigungen.

## 5.5 Berechtigungsmodell

Implementiere serverseitige rollenbasierte Berechtigungen mit feingranularer Ressourcenkontrolle.

Geeignete Rollen:

- Owner
- Admin
- Editor
- Commenter
- Viewer

Berechtigungen müssen auf folgenden Ebenen möglich sein:

- Organisation
- Space
- Ordner
- Seite
- Datenbank
- Datenbankeintrag
- Whiteboard

Unterstütze Berechtigungsvererbung sowie explizit eingeschränkte Unterbereiche.

Die Vererbung muss eindeutig definiert und getestet werden.

Ein Benutzer darf niemals über eine abgeleitete Ansicht oder einen API-Endpunkt Informationen aus einem nicht freigegebenen Space erhalten.

# 6. Navigation und Seitenstruktur

Die Navigation soll sich an der intuitiven Bedienung von Notion orientieren.

## 6.1 Sidebar

Implementiere:

- Workspace- beziehungsweise Space-Switcher
- Favoriten
- Zuletzt geöffnet
- Private Spaces
- Team-Spaces
- Verschachtelte Seiten
- Ordner
- Datenbanken
- Whiteboards
- Papierkorb
- Einstellungen
- Administration, wenn berechtigt

Seiten und Ordner können per Drag-and-Drop verschoben werden.

Die Navigation muss bei großen Seitenhierarchien performant bleiben.

## 6.2 Seiten

Jede Seite kann enthalten:

- Titel
- Icon
- Cover
- Rich-Text-Inhalt
- Unterseiten
- Eingebettete Datenbanken
- Whiteboards
- Dateien
- Kommentare
- Metadaten
- Berechtigungen
- Versionsverlauf

Unterstütze Breadcrumbs, Favoriten, Suche, Verlinkungen und Backlinks.

Seiten sollen andere Seiten referenzieren und als eingebettete Vorschau darstellen können.

# 7. Blockbasierter Editor

Entwickle einen hochwertigen Block-Editor als Herzstück von Orvyn.

Nutze vorzugsweise Tiptap/ProseMirror mit einer Erweiterungsarchitektur.

## 7.1 Unterstützte Blocks

Mindestens:

- Paragraph
- Heading 1/2/3
- Bulleted List
- Numbered List
- Checklist
- Quote
- Callout
- Divider
- Toggle
- Code Block mit Syntax Highlighting
- Tabelle
- Bild
- Datei
- Link Preview
- Embed
- Unterseite
- Datenbank
- Whiteboard
- Inhaltsverzeichnis
- Mehrspaltiges Layout

## 7.2 Editor-Interaktionen

Unterstütze:

- Slash Commands über `/`
- Floating Toolbar
- Markdown-Shortcuts
- Drag-and-Drop von Blocks
- Verschieben mehrerer Blocks
- Multi-Block-Selektion
- Undo/Redo
- Copy/Paste
- Tastaturkürzel
- Links zu anderen Seiten
- Erwähnungen
- Automatische Speicherung
- Überschriftennavigation
- Code-Sprachenauswahl

Die Bedienung muss sich schnell, direkt und vorhersehbar anfühlen.

## 7.3 Speicherung

Verwende ein strukturiertes Editorformat.

Keine Speicherung ausschließlich als HTML.

Definiere stabile Schemas für Dokumente und Blocktypen.

Unterstütze die Migration älterer Dokumentversionen.

Speichere den kollaborativen Dokumentzustand dauerhaft und sorge für sichere Wiederherstellung nach Verbindungsabbrüchen.

# 8. Live Collaboration

Live Collaboration ist verpflichtend und kein optionales Zusatzfeature.

Verwende vorzugsweise:

- Yjs als CRDT
- Tiptap Collaboration
- Einen geeigneten WebSocket-basierten Collaboration Service

Prüfe geeignete Provider wie Hocuspocus und deren aktuelle Lizenzen.

## 8.1 Funktionen

Implementiere:

- Gleichzeitiges Bearbeiten durch mehrere Benutzer
- Live-Cursors
- Benutzerpräsenz
- Auswahlmarkierungen anderer Benutzer
- Synchronisierte Änderungen
- Automatische Konfliktauflösung
- Wiederverbindung nach Netzwerkunterbrechungen
- Persistente Dokumentzustände
- Kommentare
- Erwähnungen
- Änderungs- und Versionsverlauf

## 8.2 Sicherheit

Jede WebSocket-Verbindung muss authentifiziert und autorisiert werden.

Berechtigungen müssen auch beim Zugriff auf kollaborative Dokumenträume gelten.

Wird einem Benutzer der Zugriff entzogen, muss eine bestehende Verbindung entsprechend beendet oder eingeschränkt werden.

Clientseitige Filterung reicht nicht aus.

## 8.3 Skalierung

Die Kollaborationsarchitektur muss mit mehreren Service-Replikaten funktionieren.

Verteilte Synchronisation, persistente Speicherung und Reconnect-Verhalten müssen getestet werden.

Verwende Redis oder eine andere geeignete Koordinationslösung, sofern notwendig.

Vermeide Race Conditions und Datenverlust.

## 8.4 Offline-Verhalten

Berücksichtige späteren Offline-Support architektonisch.

Für die erste Version ist zuverlässige Online-Kollaboration wichtiger.

Bereits implementierte Offline-Zustände dürfen keine falsche Synchronisation vortäuschen.

# 9. Notion-artige Datenbanken

Datenbanken sind eine zentrale Funktion von Orvyn.

Sie dürfen nicht lediglich als statische HTML-Tabellen implementiert werden.

## 9.1 Datenbankmodell

Jede Datenbank besitzt:

- Schema
- Properties
- Records
- Views
- Filter
- Sortierungen
- Gruppen
- Berechtigungen

**Jeder Datenbankeintrag ist gleichzeitig eine vollwertige Orvyn-Seite.**

Ein Record muss also eigenen Seiteninhalt, Kommentare, Unterseiten, Dateien und Metadaten besitzen können.

## 9.2 Property-Typen

Implementiere mindestens:

- Title
- Text
- Number
- Select
- Multi-Select
- Status
- Date
- Checkbox
- URL
- Email
- Phone
- Person
- Files
- Relation
- Formula
- Rollup
- Created Time
- Created By
- Last Edited Time
- Last Edited By

Komplexe Property-Typen können in klar definierten Entwicklungsphasen umgesetzt werden, müssen aber von Anfang an im Datenmodell berücksichtigt werden.

## 9.3 Database Views

Unterstütze:

- Table
- Board / Kanban
- List
- Calendar
- Gallery
- Timeline als spätere Erweiterung

Jede View besitzt eigene:

- Filter
- Sortierung
- Gruppierung
- Sichtbare Properties
- Reihenfolge
- Darstellungseinstellungen

Mehrere Views greifen auf dieselben Datensätze zu.

## 9.4 Kanban

Kanban muss Folgendes unterstützen:

- Gruppierung nach Status oder Select
- Drag-and-Drop zwischen Spalten
- Sofortige Aktualisierung
- Gemeinsame Echtzeitaktualisierung
- Konfigurierbare Spalten
- Kartenansicht mit Properties
- Öffnen der vollständigen Record-Seite

## 9.5 Datenbankfunktionen

Implementiere:

- Inline-Datenbanken
- Vollseitige Datenbanken
- Verknüpfte Datenbankansichten
- Datenbankvorlagen
- Datensatzvorlagen
- Suche
- Filtern
- Sortieren
- Gruppieren
- Import und Export

Nutze ein Schema, das auch große Datenmengen effizient abfragen kann.

Datenbankansichten sollen serverseitige Pagination beziehungsweise Virtualisierung verwenden, wenn nötig.

# 10. Whiteboards und Diagramme

Integriere eine vollwertige Whiteboard-Funktion ähnlich Excalidraw oder draw.io.

Die Integration soll sich wie ein nativer Bestandteil von Orvyn anfühlen.

## 10.1 Technische Auswahl

Prüfe Excalidraw, tldraw und geeignete Diagrammbibliotheken bezüglich:

- Lizenz
- Vue-Kompatibilität
- Embedding
- Speichermodell
- Collaboration
- Export
- Erweiterbarkeit

Da Orvyn Vue verwendet, darf ein React-basierter Editor nicht unüberlegt in die gesamte App-Architektur eingreifen.

Eine isolierte Integration ist möglich.

Falls erforderlich, entwickle einen passenden Adapter.

## 10.2 Funktionen

Unterstütze:

- Infinite Canvas
- Rechtecke
- Kreise
- Linien
- Pfeile
- Verbindungspunkte
- Text
- Freihandzeichnen
- Gruppierung
- Zoom
- Pan
- Bilder
- Export als PNG/SVG
- Speicherung im Space
- Einbettung in Dokumente

## 10.3 Collaboration

Whiteboards sollen ebenfalls gemeinsames Bearbeiten unterstützen.

Berücksichtige Live-Cursors und synchronisierte Änderungen.

Verwende nach Möglichkeit eine konsistente Presence- und Berechtigungsinfrastruktur mit dem Dokumenteditor.

# 11. Public Sharing

Orvyn benötigt ein flexibles öffentliches Freigabesystem.

## 11.1 Freigabefähige Inhalte

Öffentlich teilbar sein müssen:

- Einzelne Seiten
- Gesamte Ordner beziehungsweise Seitenhierarchien
- Datenbanken
- Datenbankansichten
- Ausgewählte Records
- Whiteboards

Eine Veröffentlichung darf nicht automatisch den vollständigen übergeordneten Space öffentlich machen.

## 11.2 Share-Links

Unterstütze:

- Private Freigaben an Benutzer
- Freigabe an Space-Mitglieder
- Öffentliche Links
- Schreibgeschützte Links
- Optional passwortgeschützte Links
- Optionales Ablaufdatum
- Deaktivieren und Widerrufen von Links

Öffentliche Schreib- oder Kommentierrechte dürfen nicht implizit aktiviert werden.

## 11.3 Public Pages

Öffentliche Seiten sollen:

- Ohne Login erreichbar sein
- Responsiv funktionieren
- Optional indexierbar sein
- Eine passende Seitenvorschau besitzen
- Metadaten für Social Sharing bereitstellen
- Anhänge nur entsprechend den Freigaberechten anbieten
- Das konfigurierte White-Label-Branding verwenden

Public Sharing muss für Datenbanken deren Views und Record-Seiten korrekt berücksichtigen.

## 11.4 Sicherheit

Besonders wichtig:

- Keine unabsichtliche Veröffentlichung privater Child-Pages
- Keine Offenlegung nicht freigegebener Datenbank-Properties
- Keine Zugriffsumgehung über Relationen
- Keine Offenlegung privater Anhänge
- Kein Zugriff über erratbare interne IDs
- Sichere Widerrufbarkeit
- Separate Veröffentlichungspolitik für verschachtelte Inhalte

Stelle im Freigabedialog klar dar, welche untergeordneten Inhalte sichtbar werden.

# 12. Suche und Wissensverknüpfung

Implementiere eine globale Suche über alle Inhalte, auf die der jeweilige Benutzer zugreifen darf.

Unterstütze:

- Seitentitel
- Dokumentinhalt
- Datenbankeinträge
- Tags
- Metadaten
- Space-Filter
- Typ-Filter

Nutze zunächst PostgreSQL Full Text Search, sofern ausreichend.

Die Architektur muss später eine dedizierte Suchlösung ermöglichen.

Implementiere außerdem:

- Backlinks
- Verweise zwischen Seiten
- Erwähnungen
- Zuletzt verwendete Inhalte
- Favoriten
- Command Palette
- Quick Search

Die Suche darf niemals Daten aus nicht berechtigten Spaces zurückgeben.

# 13. White-Labeling und Branding

White-Labeling ist eine Kernanforderung.

Erstelle eine Administratoroberfläche, über die die Plattform ohne Codeänderungen angepasst werden kann.

## 13.1 Branding

Konfigurierbar sind mindestens:

- Plattformname
- Logo
- Favicon
- App-Beschreibung
- Tagline
- Primärfarbe
- Akzentfarbe
- Login-Seiten-Branding
- Standardtheme
- Standard-Sprache
- Öffentliche Seiten
- E-Mail-Absendername
- E-Mail-Vorlagen

Das Standardbranding lautet:

**orvyn. — Your knowledge. Organized.**

## 13.2 Branding-Ebenen

Unterscheide ausdrücklich zwischen:

1. **Instance Branding:** Globale Identität der Installation.
2. **Organization Branding:** Optional eigene Identität einer Organisation.
3. **Space Appearance:** Icon, Cover, Farbe und Darstellung einzelner Spaces.

Organisationen dürfen bei entsprechend aktivierter Funktion eigene Logos und Akzentfarben verwenden.

Benutzer dürfen nicht durch Änderung ihrer Space-Einstellungen globale Instance-Konfigurationen überschreiben.

## 13.3 Admin-Oberfläche

Erstelle eine vollständige Admin-Oberfläche mit:

- Dashboard
- Benutzerverwaltung
- Organisationen
- Spaces
- SSO-Konfiguration
- Branding
- Sicherheit
- Sharing-Richtlinien
- Storage-Einstellungen
- E-Mail-Konfiguration
- Systeminformationen
- Audit Logs

Die Admin-Oberfläche darf nur entsprechend autorisierten Benutzern zugänglich sein.

## 13.4 Desktop-Branding

Trenne dynamisches Serverbranding von der Identität des installierten Desktop-Clients.

Die Desktop-App darf nach Login das serverseitige Branding anzeigen.

App-ID, Codesignatur und technische Paketidentität bleiben jedoch stabil.

Ein kundenspezifisch gebrandetes Installationspaket benötigt einen eigenen Build- und Signierungsprozess.

# 14. Designsystem und UI/UX

Die Oberfläche ist ein wesentliches Qualitätsmerkmal von Orvyn.

## 14.1 Designphilosophie

Orientiere dich an der Klarheit und Bedienbarkeit von Notion:

- Ruhige Oberfläche
- Großzügiger Content-Bereich
- Klare Navigation
- Wenig visuelles Rauschen
- Schnelle Interaktionen
- Sehr gute Typografie
- Konsistente Abstände
- Kontextbezogene Bedienelemente

Erweitere das Ganze um eine eigenständige **Cybercade-Designsprache**.

Cybercade bedeutet hier eine elegante Mischung aus:

- Dark UI
- Cyberpunk
- Minimalismus
- Präzisen Neon-Akzenten
- Moderner Developer-Ästhetik
- Hochwertiger Desktop-Software

**Wichtig:** Cybercade darf nicht wie ein überladener Gaming-Launcher aussehen.

Produktivität und Lesbarkeit haben Vorrang.

## 14.2 Themes

Implementiere:

- Cybercade — eigenständiges Standardtheme
- Graphite — neutrales Dunkel
- Midnight
- Nord
- Carbon — Dunkelgrau mit blauen Akzenten
- Matrix — Schwarz/Grün
- Light — vollwertiges helles Theme

Alle Farben müssen über semantische Design-Tokens gesteuert werden.

Keine hartkodierten Farben über verschiedene Komponenten verteilen.

## 14.3 Cybercade Theme

Die visuelle Richtung:

- Sehr dunkler, leicht bläulicher Hintergrund
- Dezente Panel-Abstufungen
- Violette Akzentfarbe
- Kontrollierte Neon-Highlights
- Leichte Glow-Effekte ausschließlich an ausgewählten Stellen
- Feine Borders
- Moderne, weiche Radien
- Subtile Animationen
- Hochwertige Hover- und Focus-States
- Zurückhaltende Tiefeneffekte

Der eigentliche Editor muss besonders ruhig und gut lesbar bleiben.

## 14.4 Typografie

Liefere lokal mit:

- Inter Variable für die Oberfläche
- JetBrains Mono Variable für Code

Keine externen Font-CDNs.

Schriftlizenzen beilegen.

Globale Basisschriftgröße:

- XS: 12 px
- SM: 13 px
- MD: 14 px
- LG: 16 px
- XL: 18 px

MD ist Standard.

Nutze `rem` für skalierende UI-Größen.

## 14.5 UI-Komponenten

Implementiere ein gemeinsames Designsystem mit:

- Buttons
- Inputs
- Dialogs
- Popovers
- Tooltips
- Dropdowns
- Context Menus
- Tabs
- Sidebar
- Command Palette
- Data Tables
- Cards
- Notifications
- Breadcrumbs
- Drag-and-Drop
- Loading States
- Empty States

Kontextmenüs müssen vollständig tastaturbedienbar sein.

Nutze sinnvolle ARIA-Zustände.

Bevorzuge gemeinsame eigene beziehungsweise passend angepasste Nuxt-UI-Komponenten anstelle verstreuter Einzellösungen.

## 14.6 Responsive Layout

Die Web-App muss auf Desktop, Tablet und kleineren Bildschirmen funktionieren.

Mobile Browser sollen eine benutzbare Oberfläche erhalten.

Native Mobile Apps sind ausdrücklich nicht Teil der initialen Entwicklung.

Die Architektur muss sie jedoch später erlauben.

# 15. Internationalisierung und Einstellungen

Unterstütze mindestens:

- Deutsch
- Englisch
- System-Sprache

Die Sprache muss zur Laufzeit ohne Neustart gewechselt werden können.

Übersetze UI-Texte, aber niemals automatisch Benutzerinhalte, Dateipfade, Code oder technische IDs.

Implementiere Einstellungen für:

- Darstellung
- Sprache
- Schriftgröße
- Benachrichtigungen
- Account
- Sicherheit
- Sessions
- Desktop-Updates
- Programminfo

Lokale Darstellungseinstellungen sollen pro Installation beziehungsweise Gerät möglich sein.

Space-Daten und Benutzerdokumente müssen serverseitig gespeichert werden.

# 16. Kommentare, Benachrichtigungen und Aktivität

Implementiere:

- Seitenkommentare
- Threaded Comments
- Kommentare an ausgewählten Textbereichen
- Erwähnungen
- Auflösen und Wiederöffnen von Kommentaren
- In-App-Benachrichtigungen
- Optional E-Mail-Benachrichtigungen
- Aktivitätsverlauf

Eine Benachrichtigung darf keine Inhalte verraten, auf die der Benutzer inzwischen keinen Zugriff mehr besitzt.

# 17. Dateiverwaltung

Nutze S3-kompatiblen Object Storage.

Unterstütze:

- Datei-Uploads
- Bilder
- Anhänge
- Dateivorschau
- Sichere Download-Links
- Datei-Metadaten
- Konfigurierbare Größenlimits
- Zugriffskontrolle
- Aufräumen verwaister Dateien

Der Object Storage darf private Dateien nicht über allgemein öffentliche Bucket-URLs zugänglich machen.

Nutze geeignete signierte URLs oder autorisierte Download-Endpunkte.

# 18. Import und Export

Unterstütze langfristig die Migration aus anderen Knowledge-Management-Systemen.

Initial vorzusehen:

- Markdown Import
- Markdown Export
- CSV Import für Datenbanken
- CSV Export
- JSON Export
- Export von Seitenhierarchien
- Export von Anhängen

Die Datenmodelle sollen später einen Notion-Import ermöglichen.

Ein Notion-Import ist erst als fertig zu kennzeichnen, wenn Seiten, Datenbanken, Properties und Anhänge verlässlich übernommen werden.

# 19. API und Erweiterbarkeit

Entwickle eine dokumentierte API.

Verwende:

- REST für Standardoperationen
- OpenAPI-Schemas
- WebSockets für kollaborative Funktionen
- Versionierte API-Endpunkte
- Validierte Eingaben
- Strukturierte Fehlerantworten

Plane Erweiterungspunkte für:

- Integrationen
- Automatisierungen
- Webhooks
- Plugin-ähnliche Funktionen
- Importer
- Exporter
- Erweiterte Datenbank-Properties

Keine unnötig komplexe Plugin-Runtime in der ersten Version implementieren.

# 20. Kubernetes und Self-Hosting

Orvyn muss vollständig auf Kubernetes deploybar sein.

## 20.1 Container

Erstelle mehrstufige Container-Builds.

Verwende kleine, sichere Runtime-Images.

Container sollen soweit möglich ohne Root-Rechte laufen.

Liefere getrennte Images für die erforderlichen Anwendungskomponenten.

## 20.2 Helm

Stelle ein Helm Chart bereit.

Konfigurierbar sind:

- Domain
- Ingress
- TLS
- Replikazahlen
- Image-Tags
- PostgreSQL-Verbindung
- Redis-Verbindung
- Object Storage
- SMTP
- SSO
- Branding-Grundkonfiguration
- Storage
- Resource Requests/Limits
- Secrets
- Security Contexts
- Persistence

Berücksichtige bestehende PostgreSQL-, Redis- und S3-Dienste.

Externe Dienste müssen ohne Änderungen am Anwendungscode verwendet werden können.

## 20.3 Deployment

Unterstütze:

- Kubernetes
- RKE2
- k3s
- Beliebige standardkonforme Kubernetes-Distributionen

Verwende Standard-Kubernetes-Ressourcen, soweit möglich.

WebSocket-Verbindungen müssen über den Ingress korrekt funktionieren.

## 20.4 Skalierung

Unterstütze mehrere Web- und API-Replikate.

Die Collaboration-Komponente muss horizontal skalierbar ausgelegt sein.

Vermeide erforderliche lokale Prozesszustände für dauerhaft gespeicherte Benutzerdaten.

Definiere Readiness- und Liveness-Probes.

## 20.5 Datenbank

PostgreSQL ist die Quelle der Wahrheit für strukturierte Daten.

Verwende:

- Migrationen
- Indizes
- Transaktionen
- Referential Integrity
- Optimistische Konkurrenzkontrolle, wo passend
- Datenintegritätstests

Datenbankänderungen müssen während Deployments kontrolliert erfolgen.

## 20.6 Sicherheit

Implementiere:

- Kubernetes Secrets beziehungsweise External Secrets
- Sichere Default-Konfiguration
- Netzwerksegmentierung, soweit sinnvoll
- Minimal notwendige Containerrechte
- Keine eingebetteten produktiven Credentials
- TLS
- Security Headers
- Sichere CORS-Konfiguration
- Rate Limiting
- Audit Logs

## 20.7 Observability

Stelle bereit:

- Strukturierte Logs
- Health Checks
- Metriken
- OpenTelemetry-kompatible Tracing-Instrumentierung
- Prometheus-kompatible Metriken, wo sinnvoll

Keine Passwörter, Tokens oder vertraulichen Dokumentinhalte protokollieren.

## 20.8 Backup und Recovery

Dokumentiere:

- PostgreSQL-Backups
- Object-Storage-Backups
- Redis-Persistenzanforderungen
- Wiederherstellung
- Migration zwischen Installationen
- Disaster Recovery

Teste mindestens einen automatisierten Restore-Pfad in einer isolierten Testumgebung.

# 21. Lokale Entwicklung

Erstelle eine verständliche lokale Entwicklungsumgebung.

Bereitstellen:

- `.env.example`
- Docker Compose für erforderliche Infrastruktur
- pnpm Workspace Scripts
- Datenbankmigrationen
- Dev-Server
- Seed-Daten ausschließlich für Entwicklungsumgebungen
- Dokumentierter Setup-Prozess

Ein neuer Entwickler muss Orvyn ohne ein vorhandenes Kubernetes-Cluster lokal entwickeln können.

Nutze Node.js 22 oder neuer und pnpm mit Lockfile.

Erzwinge keinen unbegründeten Wechsel zu einer fest kodierten pnpm-Version.

# 22. Desktop Packaging und Releases

Übernimm für die Tauri-App folgende Anforderungen.

## 22.1 Plattformen

Unterstütze:

- Windows
- macOS
- Linux

Bereitstellen:

**Windows**

- Portable `.exe`
- NSIS Setup `.exe`

**macOS**

- `.app.zip`
- `.dmg`

**Linux**

- `.AppImage`
- `.deb`
- `.flatpak`
- `.flatpakref` für stabile Releases

Dateinamen müssen Version, Plattform und tatsächliche Architektur enthalten.

## 22.2 Versionierung

Implementiere:

- `pnpm release:version patch`
- `pnpm release:version minor`
- `pnpm release:version major`
- Explizite SemVer-Version
- `--dry-run`

Synchronisiere relevante Versionen in:

- package.json
- Tauri-Konfiguration
- Eigenen Cargo-Paketen
- Cargo.lock

Verändere dabei keine Versionsnummern fremder Abhängigkeiten.

Kein automatisches Committen, Taggen oder Pushen durch diesen Befehl.

## 22.3 GitHub Releases

Erstelle GitHub Actions Workflows.

Produktive Release-Builds starten bei Push gültiger Versionstags.

Prüfe Tag und Manifestversionen vor dem Build.

Verwende geeignete aktuelle GitHub-Actions mit Node-24-kompatibler Runtime.

Veröffentliche:

- Einzelne Installationsdateien
- SHA-256-Prüfsummen
- Release Notes
- Signaturen
- Erforderliche Update-Metadaten

Release-Artefakte dürfen nicht unbemerkt überschrieben werden.

Trenne Stable und Prerelease.

## 22.4 Desktop Updates

Implementiere einen sicheren Update-Flow.

Unterstütze:

- Updateprüfung beim Start
- Prüfung nach erneutem Fokus mit angemessenem Mindestintervall
- Manuelle Updateprüfung
- Release Notes
- Fortschrittsanzeige
- Fehlerbehandlung
- Explizite Installationsbestätigung

Kein automatischer Download und keine Installation ohne Benutzerzustimmung.

Prüfe:

- Signatur
- Version
- Downloadintegrität
- HTTPS
- Installationsart

Kein Downgrade bei ungültiger oder älterer Version.

Die Updatefähigkeit muss zur tatsächlichen Installationsform passen.

## 22.5 Signierung

Verwende Tauri-Updater-Signaturen.

Private Schlüssel bleiben in geschützten lokalen Dateien beziehungsweise GitHub Actions Secrets.

Unterscheide Tauri-Update-Signierung, Windows Authenticode und Apple Code Signing/Notarization.

## 22.6 Flatpak Repository

Stelle nach Möglichkeit eine eigene signierte Flatpak-Paketquelle über GitHub Pages bereit.

Verwende:

- OSTree
- GPG-Signaturen
- `.flatpakref`
- `.flatpakrepo`
- Eigene Paketquelle

Der Flatpak-Updater soll den vorgesehenen Flatpak-/Portal-Updateweg nutzen, statt AppImage- oder Tauri-Pakete zu installieren.

Behandle zusätzliche Berechtigungen und Paketquellenwechsel ausdrücklich.

Ein stabiles Release darf nicht durch eine Vorabversion ersetzt werden.

## 22.7 Server Releases

Erstelle zusätzlich Container-Images für Web, API, Collaboration und Worker.

Veröffentliche sie über GHCR mit versionierten Tags.

`latest` darf nur stabile Releases referenzieren.

Server-Updates und Desktop-Updates sind unabhängige Vorgänge.

Ein Desktop-Update darf niemals automatisch ein Kubernetes-Deployment verändern.

# 23. Mobile Apps – zukünftige Erweiterung

Die Architektur soll native Mobile Apps später ermöglichen.

Zielplattformen:

- iOS
- Android

Mobile ist aktuell **keine Entwicklungspriorität**.

Berücksichtige dennoch:

- Wiederverwendbare APIs
- Wiederverwendbare Design-Tokens
- Plattformunabhängige Businesslogik
- Responsive Komponenten
- Mobile Authentifizierung
- Spätere Push-Benachrichtigungen
- Späteren Offline-Sync

Implementiere jetzt keine leeren mobilen App-Projekte ohne funktionalen Nutzen.

# 24. Sicherheit und Datenschutz

Orvyn speichert potenziell vertrauliche Informationen.

Sicherheit ist deshalb ein Kernbestandteil.

Implementiere unter anderem:

- Server-side Authorization
- Sichere OIDC-Flows
- Schutz gegen XSS
- Schutz gegen CSRF
- Sichere Eingabevalidierung
- Schutz gegen SQL Injection
- Sichere Datei-Uploads
- Strenge Freigabekontrollen
- Audit Logging
- Sichere Secret-Verwaltung
- Session Management
- Sichere Passwort-Hashes
- Berechtigungstests
- Backup- und Restore-Strategie

Insbesondere Public Sharing, Team-Membership und Datenbank-Relationen benötigen gezielte Tests auf unberechtigten Datenzugriff.

Mandanten- beziehungsweise Organisationsgrenzen müssen auf sämtlichen Zugriffspfaden eingehalten werden.

# 25. Performance

Orvyn muss sich auch bei großen Workspaces flüssig anfühlen.

Berücksichtige:

- Lazy Loading
- Code Splitting
- Virtualisierte lange Listen
- Serverseitige Pagination
- Effiziente Datenbankabfragen
- Caching mit klaren Invalidierungsregeln
- Optimierte Kollaborationsnachrichten
- Bildoptimierung
- Debouncing, wo passend

Vermeide unnötige vollständige Seiten-Reloads.

Navigation und Wechsel zwischen Datenbankansichten sollen schnell wirken.

# 26. Tests und Qualität

Nutze eine angemessene Teststrategie.

## 26.1 Frontend

- TypeScript Checks
- Linting
- Formatierung
- Unit Tests
- Component Tests
- E2E Tests mit Playwright

## 26.2 Backend

- Unit Tests
- Integration Tests
- API Tests
- Berechtigungstests
- Datenbankmigrationstests

## 26.3 Collaboration

Teste:

- Gleichzeitiges Bearbeiten
- Reconnect
- Konfliktauflösung
- Persistenz
- Rechteentzug
- Mehrere Collaboration-Replikate

## 26.4 Sharing

Teste:

- Private Inhalte bleiben privat
- Öffentliche Links
- Widerruf
- Ablaufdatum
- Nested Permissions
- Datenbank-Relationen
- Anhänge
- Organisationstrennung

## 26.5 Desktop

Teste:

- IPC
- Updatecontroller
- Signaturprüfung
- Installationsart
- Downloadfehler
- Aktive Arbeit beim Update
- Plattformabhängige Funktionen

Gib nicht vor, Windows oder macOS getestet zu haben, wenn ausschließlich Linux-Tests ausgeführt wurden.

# 27. Dokumentation

Erstelle mindestens:

- README.md
- ARCHITECTURE.md
- DEVELOPMENT.md
- DEPLOYMENT.md
- SECURITY.md
- CONTRIBUTING.md
- RELEASE.md
- API-Dokumentation
- Helm-Dokumentation
- Umgebungsvariablen-Referenz

Dokumentiere:

- Lokale Entwicklung
- Architektur
- Datenmodelle
- Authentifizierung
- Berechtigungen
- Collaboration
- Kubernetes-Deployment
- Storage
- Backups
- Desktop Builds
- Release-Prozess
- Einmalige Einrichtungsschritte

# 28. Entwicklungsphasen

Arbeite iterativ, aber mit einer von Anfang an tragfähigen Architektur.

## Phase 1 — Foundation

- Monorepo
- Gemeinsames Designsystem
- Web-App
- Backend
- PostgreSQL
- Redis
- Object Storage
- Lokale Entwicklungsumgebung
- Authentifizierung
- OIDC
- Benutzerverwaltung
- Grundlegende Kubernetes-Konfiguration
- Tauri-Shell

## Phase 2 — Core Workspace

- Persönliche Spaces
- Team-Spaces
- Seitenhierarchie
- Ordner
- Berechtigungen
- Sidebar
- Suche
- Block-Editor
- Datei-Uploads
- Auto-Save

## Phase 3 — Collaboration

- Yjs
- WebSocket Collaboration
- Live-Cursors
- Presence
- Kommentare
- Reconnect
- Persistente Dokumentzustände
- Versionsverlauf

## Phase 4 — Databases

- Datenbankschema
- Properties
- Record-Seiten
- Table View
- Kanban
- List
- Calendar
- Gallery
- Filter
- Sortierung
- Relations
- Formulas und Rollups

## Phase 5 — Whiteboards

- Canvas Editor
- Diagramme
- Einbettung in Seiten
- Export
- Live Collaboration

## Phase 6 — Sharing und White-Labeling

- Public Sharing
- Hierarchische Freigaben
- Public Pages
- Admin Dashboard
- Branding
- Organisationseinstellungen
- E-Mail-Templates

## Phase 7 — Production Hardening

- Security Audit
- Performance
- Observability
- Backup/Restore
- Helm Chart
- Skalierung
- E2E Tests
- Desktop Packaging
- Signierte Updates
- GitHub Releases
- Flatpak Repository

Die Phasen sind eine Entwicklungsreihenfolge, keine voneinander unabhängigen Prototypen.

# 29. Arbeitsweise für Codex

Gehe bei der Implementierung wie folgt vor:

1. Analysiere zuerst das vorhandene Repository.
2. Lies eine vorhandene `AGENTS.md` und relevante Projektdokumentation.
3. Erhalte bereits vorhandene funktionierende Implementierungen.
4. Prüfe die technische Kompatibilität der gewählten Bibliotheken.
5. Definiere zuerst eine sinnvolle Architektur und ein stabiles Datenmodell.
6. Erstelle die gemeinsame Projektstruktur.
7. Implementiere anschließend schrittweise vollständige, vertikale Funktionsbereiche.
8. Vermeide isolierte UI-Mockups ohne Backend-Anbindung.
9. Implementiere echte Persistenz und echte Berechtigungsprüfungen.
10. Schreibe und führe relevante Tests aus.
11. Dokumentiere Architekturentscheidungen und bekannte Einschränkungen.
12. Erstelle fokussierte Commits nach erfolgreichen Prüfungen.
13. Erstelle keine Releases und pushe keine Tags ohne ausdrücklichen Auftrag.

Arbeite selbstständig innerhalb des definierten Projektumfangs.

Bei kleineren technischen Detailentscheidungen wähle die sinnvollste wartbare Lösung.

Bei grundlegenden Architekturentscheidungen begründe die Wahl nachvollziehbar.

**Wichtig:** Reduziere den Funktionsumfang nicht heimlich auf eine Demo. Wenn ein Feature noch nicht fertig ist, kennzeichne es ausdrücklich als unvollständig.

# 30. Definition of Done

Orvyn gilt als produktionsreif, wenn folgende Anforderungen erfüllt sind:

- Die Web-App funktioniert eigenständig.
- Die Anwendung kann auf Kubernetes installiert werden.
- Die Desktop-App verbindet sich mit derselben Serverplattform.
- Benutzer können sich lokal oder über OIDC anmelden.
- Jeder neue Space ist standardmäßig privat.
- Benutzer können private und gemeinsame Spaces verwalten.
- Berechtigungen werden serverseitig erzwungen.
- Seiten können erstellt, verschachtelt, bearbeitet und gelöscht werden.
- Der Block-Editor funktioniert einschließlich Speicherung.
- Mehrere Benutzer können gleichzeitig dasselbe Dokument bearbeiten.
- Datenbanken besitzen echte Record-Seiten und mehrere Views.
- Kanban unterstützt Drag-and-Drop.
- Whiteboards funktionieren und lassen sich einbetten.
- Seiten, Ordner, Datenbanken und Whiteboards können gezielt veröffentlicht werden.
- Private Inhalte bleiben ohne Freigabe geschützt.
- Administratoren können Branding und SSO konfigurieren.
- Das Cybercade-Theme und die weiteren Themes funktionieren.
- Deutsch und Englisch werden unterstützt.
- Die Anwendung verfügt über Tests, Dokumentation und eine nachvollziehbare Release-Pipeline.
- Desktop-Installationen unterstützen die für ihren Pakettyp vorgesehenen Updateverfahren.
- Kubernetes-Daten sind persistent und können gesichert und wiederhergestellt werden.

# 31. Abschließende Anweisung

**Entwickle Orvyn als ernstzunehmende, langfristig wartbare Notion-Alternative und nicht als Showcase oder UI-Prototyp.**

Die erste Priorität liegt auf einer hochwertigen, zuverlässigen Plattform mit sauberer Architektur.

Alle Kernfunktionen müssen später ohne grundlegenden Neuaufbau erweitert werden können.

Die Plattform soll sich wie ein zusammenhängendes Produkt anfühlen – unabhängig davon, ob ein Benutzer im Browser, unter Windows, unter macOS oder unter Linux arbeitet.

Das Produkt heißt:

**orvyn.**  
**Your knowledge. Organized.**