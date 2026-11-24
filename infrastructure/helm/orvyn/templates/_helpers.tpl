{{- define "orvyn.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 40 | trimSuffix "-" }}{{- end }}
{{- define "orvyn.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "orvyn.name" .)) .Values.fullnameOverride | trunc 45 | trimSuffix "-" -}}
{{- end }}
{{- define "orvyn.labels" -}}
app.kubernetes.io/name: {{ include "orvyn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ regexReplaceAll "[-_.]+$" (.Chart.AppVersion | replace "+" "_" | trunc 63) "" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ regexReplaceAll "[-_.]+$" (printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63) "" | quote }}
{{- end }}
{{- define "orvyn.selector" -}}
app.kubernetes.io/name: {{ include "orvyn.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}
{{- define "orvyn.image" -}}
{{- $repository := .image.repository -}}
{{- if not (or (contains "." (first (splitList "/" $repository))) (contains ":" (first (splitList "/" $repository))) (eq "localhost" (first (splitList "/" $repository)))) -}}
{{- $repository = printf "%s/%s" .root.Values.global.imageRegistry $repository -}}
{{- end -}}
{{- if .image.digest -}}{{ printf "%s@%s" $repository .image.digest }}
{{- else -}}{{ printf "%s:%s" $repository (default .root.Chart.AppVersion .image.tag | replace "+" "_") }}{{- end -}}
{{- end }}
{{- define "orvyn.secretName" -}}{{ include "orvyn.fullname" . }}-secrets{{- end }}
{{- define "orvyn.serviceAccount" -}}{{ default (printf "%s-app" (include "orvyn.fullname" .)) .Values.serviceAccount.name }}{{- end }}
{{- define "orvyn.reference" -}}
valueFrom:
  secretKeyRef:
    name: {{ default (include "orvyn.secretName" .root) .name | quote }}
    key: {{ .key | quote }}
{{- end }}
{{- define "orvyn.databaseEnv" -}}
{{- if .Values.postgresql.enabled }}
- name: PGHOST
  value: {{ printf "%s-postgresql" (include "orvyn.fullname" .) | quote }}
- name: PGPORT
  value: "5432"
- name: PGUSER
  value: {{ .Values.postgresql.auth.username | quote }}
- name: PGDATABASE
  value: {{ .Values.postgresql.auth.database | quote }}
- name: PGPASSWORD
  {{- include "orvyn.reference" (dict "root" . "name" .Values.postgresql.auth.existingSecret "key" (ternary .Values.postgresql.auth.secretKey "POSTGRES_PASSWORD" (ne .Values.postgresql.auth.existingSecret ""))) | nindent 2 }}
{{- else }}
- name: DATABASE_URL
  {{- include "orvyn.reference" (dict "root" . "name" .Values.externalPostgresql.existingSecret "key" (ternary .Values.externalPostgresql.secretKey "DATABASE_URL" (ne .Values.externalPostgresql.existingSecret ""))) | nindent 2 }}
{{- end }}
{{- end }}
{{- define "orvyn.encryptionEnv" -}}
- name: ORVYN_ENCRYPTION_KEY
  {{- include "orvyn.reference" (dict "root" . "name" .Values.global.existingEncryptionSecret "key" (ternary .Values.global.encryptionSecretKey "ORVYN_ENCRYPTION_KEY" (ne .Values.global.existingEncryptionSecret ""))) | nindent 2 }}
{{- end }}
{{- define "orvyn.storageEnv" -}}
- name: ORVYN_STORAGE_DRIVER
  value: {{ .Values.storage.driver | quote }}
{{- if eq .Values.storage.driver "local" }}
- name: ORVYN_STORAGE_LOCAL_PATH
  value: {{ .Values.storage.local.path | quote }}
{{- else }}
{{- $s3 := .Values.storage.s3 }}
- name: S3_ENDPOINT
  value: {{ ternary (printf "http://%s-storage:8333" (include "orvyn.fullname" .)) $s3.external.endpoint $s3.internal.enabled | quote }}
- name: S3_BUCKET
  value: {{ $s3.bucket | quote }}
- name: S3_REGION
  value: {{ $s3.region | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ $s3.forcePathStyle | quote }}
- name: S3_ACCESS_KEY_ID
  {{- include "orvyn.reference" (dict "root" . "name" $s3.existingSecret "key" (ternary $s3.accessKeySecretKey "S3_ACCESS_KEY_ID" (ne $s3.existingSecret ""))) | nindent 2 }}
- name: S3_SECRET_ACCESS_KEY
  {{- include "orvyn.reference" (dict "root" . "name" $s3.existingSecret "key" (ternary $s3.secretAccessKeySecretKey "S3_SECRET_ACCESS_KEY" (ne $s3.existingSecret ""))) | nindent 2 }}
{{- end }}
{{- end }}
{{- define "orvyn.smtpEnv" -}}
- name: SMTP_URL
  {{- include "orvyn.reference" (dict "root" . "name" .Values.smtp.existingSecret "key" (ternary .Values.smtp.secretKey "SMTP_URL" (ne .Values.smtp.existingSecret ""))) | nindent 2 }}
- name: MAIL_FROM
  value: {{ .Values.smtp.from | quote }}
{{- end }}
{{- define "orvyn.valkeyEnv" -}}
{{- if .Values.valkey.enabled }}
- name: VALKEY_HOST
  value: {{ printf "%s-valkey" (include "orvyn.fullname" .) | quote }}
- name: VALKEY_PORT
  value: "6379"
- name: VALKEY_PASSWORD
  {{- include "orvyn.reference" (dict "root" . "name" .Values.valkey.auth.existingSecret "key" (ternary .Values.valkey.auth.secretKey "VALKEY_PASSWORD" (ne .Values.valkey.auth.existingSecret ""))) | nindent 2 }}
{{- else }}
- name: REDIS_URL
  {{- include "orvyn.reference" (dict "root" . "name" .Values.externalValkey.existingSecret "key" (ternary .Values.externalValkey.secretKey "REDIS_URL" (ne .Values.externalValkey.existingSecret ""))) | nindent 2 }}
{{- end }}
{{- end }}
{{- define "orvyn.oidcEnv" -}}
{{- $o := .Values.sso.oidc }}
- name: ORVYN_OIDC_ENABLED
  value: {{ $o.enabled | quote }}
{{- if $o.enabled }}
- name: ORVYN_OIDC_NAME
  value: {{ $o.name | quote }}
- name: ORVYN_OIDC_ISSUER
  value: {{ $o.issuer | quote }}
- name: ORVYN_OIDC_CLIENT_ID
  value: {{ $o.clientId | quote }}
- name: ORVYN_OIDC_CLIENT_AUTH_METHOD
  value: {{ $o.clientAuthMethod | quote }}
{{- if ne $o.clientAuthMethod "none" }}
- name: ORVYN_OIDC_CLIENT_SECRET
  {{- include "orvyn.reference" (dict "root" . "name" $o.existingSecret "key" (ternary $o.secretKey "ORVYN_OIDC_CLIENT_SECRET" (ne $o.existingSecret ""))) | nindent 2 }}
{{- end }}
- name: ORVYN_OIDC_SCOPES
  value: {{ $o.scopes | quote }}
- name: ORVYN_OIDC_AUTO_PROVISION
  value: {{ $o.autoProvision | quote }}
- name: ORVYN_OIDC_ADMIN_SUBJECT
  value: {{ $o.adminSubject | quote }}
{{- end }}
{{- end }}
{{- define "orvyn.ephemeralLocal" -}}{{ and (eq .Values.storage.driver "local") (not .Values.storage.local.persistence.enabled) }}{{- end }}
{{- define "orvyn.claimName" -}}{{ default (printf "%s-%s" (include "orvyn.fullname" .root) .component) .persistence.existingClaim }}{{- end }}
{{- define "orvyn.validate" -}}
{{- if or .Values.storage.internal .Values.storage.external .Values.storage.bucket }}{{ fail "Legacy storage values must move to storage.s3; see README migration notes" }}{{ end -}}
{{- $origin := urlParse .Values.global.origin -}}
{{- if or (not (has $origin.scheme (list "http" "https"))) (not $origin.host) $origin.userinfo $origin.query $origin.fragment (and $origin.path (ne $origin.path "/")) -}}{{ fail "global.origin must be an HTTP(S) origin without credentials, path, query or fragment" }}{{- end -}}
{{- if hasSuffix "/" .Values.global.origin }}{{ fail "global.origin must not have a trailing slash" }}{{ end -}}
{{- if and .Values.ingress.tls.enabled (ne $origin.scheme "https") }}{{ fail "TLS ingress requires an HTTPS global.origin" }}{{ end -}}
{{- if and .Values.sso.oidc.enabled (ne $origin.scheme "https") }}{{ fail "OIDC requires an HTTPS global.origin" }}{{ end -}}
{{- if eq .Values.storage.driver "local" -}}
{{- $apiUid := default 1000 (default .Values.api.podSecurityContext.runAsUser .Values.api.securityContext.runAsUser) -}}
{{- $workerPodUid := ternary .Values.api.podSecurityContext.runAsUser .Values.worker.podSecurityContext.runAsUser (not .Values.storage.local.persistence.enabled) -}}
{{- $workerUid := default 1000 (default $workerPodUid .Values.worker.securityContext.runAsUser) -}}
{{- if ne (int $apiUid) (int $workerUid) }}{{ fail "Local attachment storage requires API and worker to run with the same UID" }}{{ end -}}
{{- end -}}
{{- if and (eq .Values.storage.driver "s3") (not .Values.storage.s3.internal.enabled) -}}
{{- $endpoint := urlParse .Values.storage.s3.external.endpoint -}}
{{- if or $endpoint.userinfo $endpoint.query $endpoint.fragment }}{{ fail "S3 endpoint must not contain credentials, query tokens or fragments; use its credential Secret" }}{{ end -}}
{{- end -}}
{{- if and (eq .Values.storage.driver "local") (not .Values.storage.local.persistence.enabled) (or (ne (int .Values.api.replicaCount) 1) (ne (int .Values.worker.replicaCount) 1)) }}{{ fail "Ephemeral local storage runs a worker sidecar and requires one API and one worker replica" }}{{ end -}}
{{- if and (eq .Values.storage.driver "local") .Values.storage.local.persistence.enabled (eq .Values.storage.local.persistence.accessMode "ReadWriteOnce") (or (gt (int .Values.api.replicaCount) 1) (gt (int .Values.worker.replicaCount) 1)) }}{{ fail "Multiple local-storage replicas require ReadWriteMany; ReadWriteOnce is restricted to one API and one worker on the same node" }}{{ end -}}
{{- if and .Values.ingress.tls.issuer (not .Values.ingress.tls.enabled) }}{{ fail "A cert-manager issuer requires ingress.tls.enabled" }}{{ end -}}
{{- if and (not .Values.serviceAccount.create) (not .Values.serviceAccount.name) }}{{ fail "serviceAccount.name is required when create=false" }}{{ end -}}
{{- end }}
{{- define "orvyn.container" -}}
{{- $root := .root }}{{- $component := .component }}{{- $settings := index $root.Values $component }}
- name: {{ $component }}
  image: {{ include "orvyn.image" (dict "root" $root "image" $settings.image) | quote }}
  imagePullPolicy: {{ $settings.image.pullPolicy }}
  securityContext: {{- toYaml $settings.securityContext | nindent 4 }}
  resources: {{- toYaml $settings.resources | nindent 4 }}
  {{- if ne $component "worker" }}
  ports:
    - name: http
      containerPort: {{ index (dict "web" 3000 "api" 3001 "collaboration" 3002) $component }}
  {{- end }}
  env:
    - name: NODE_ENV
      value: production
    {{- if eq $component "web" }}
    - name: NITRO_HOST
      value: "0.0.0.0"
    - name: NITRO_PORT
      value: "3000"
    - name: NUXT_API_URL
      value: {{ printf "http://%s-api:%v" (include "orvyn.fullname" $root) $root.Values.api.service.port | quote }}
    - name: NUXT_COLLABORATION_UPSTREAM
      value: {{ printf "ws://%s-collaboration:%v" (include "orvyn.fullname" $root) $root.Values.collaboration.service.port | quote }}
    - name: NUXT_PUBLIC_COLLABORATION_URL
      value: ""
    {{- else }}
    - name: ORVYN_ORIGIN
      value: {{ $root.Values.global.origin | quote }}
    {{- include "orvyn.databaseEnv" $root | nindent 4 }}
    {{- if eq $component "collaboration" }}
    {{- include "orvyn.valkeyEnv" $root | nindent 4 }}
    - name: COLLABORATION_PORT
      value: "3002"
    - name: COLLABORATION_NAMESPACE
      value: {{ $root.Values.collaboration.namespace | quote }}
    {{- else }}
    {{- include "orvyn.encryptionEnv" $root | nindent 4 }}
    {{- include "orvyn.storageEnv" $root | nindent 4 }}
    {{- if eq $component "worker" }}
    {{- include "orvyn.smtpEnv" $root | nindent 4 }}
    {{- else }}
    - name: PORT
      value: "3001"
    - name: MAX_UPLOAD_BYTES
      value: {{ $root.Values.api.maxUploadBytes | quote }}
    - name: ORVYN_OIDC_BOOTSTRAP_MODE
      value: external
    {{- if $root.Values.sso.oidc.ca.existingSecret }}
    - name: NODE_EXTRA_CA_CERTS
      value: /etc/orvyn/oidc/ca.crt
    {{- end }}
    {{- end }}
    {{- end }}
    {{- end }}
  {{- range $name := list "startupProbe" "readinessProbe" "livenessProbe" }}
  {{- with index $settings $name }}
  {{ $name }}: {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- end }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
    {{- if and (has $component (list "api" "worker")) (eq $root.Values.storage.driver "local") }}
    - name: attachments
      mountPath: {{ $root.Values.storage.local.path | quote }}
    {{- end }}
    {{- if and (eq $component "api") $root.Values.sso.oidc.ca.existingSecret }}
    - name: oidc-ca
      mountPath: /etc/orvyn/oidc
      readOnly: true
    {{- end }}
{{- end }}
