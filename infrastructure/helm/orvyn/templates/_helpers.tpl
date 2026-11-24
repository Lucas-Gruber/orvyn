{{- define "orvyn.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "orvyn.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "orvyn.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "orvyn.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "orvyn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "orvyn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "orvyn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "orvyn.image" -}}
{{- printf "%s/%s:%s" .root.Values.global.imageRegistry .image.repository (default .root.Chart.AppVersion .image.tag) -}}
{{- end -}}

{{- define "orvyn.secretName" -}}
{{- printf "%s-secrets" (include "orvyn.fullname" .) -}}
{{- end -}}

{{- define "orvyn.secretValue" -}}
{{- $value := .value -}}
{{- if not $value -}}
  {{- $secret := lookup "v1" "Secret" .root.Release.Namespace (include "orvyn.secretName" .root) -}}
  {{- if and $secret $secret.data (hasKey $secret.data .key) -}}
    {{- $value = index $secret.data .key | b64dec -}}
  {{- else -}}
    {{- $value = .fallback -}}
  {{- end -}}
{{- end -}}
{{- $value -}}
{{- end -}}

{{- define "orvyn.storageClass" -}}
{{- $class := default .root.Values.global.storageClass .persistence.storageClass -}}
{{- if $class }}
storageClassName: {{ $class | quote }}
{{- end -}}
{{- end -}}

{{- define "orvyn.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      {{- if and (not .Values.postgresql.enabled) .Values.externalPostgresql.existingSecret }}
      name: {{ .Values.externalPostgresql.existingSecret }}
      key: {{ .Values.externalPostgresql.secretKey }}
      {{- else }}
      name: {{ include "orvyn.secretName" . }}
      key: DATABASE_URL
      {{- end }}
{{- end -}}

{{- define "orvyn.encryptionEnv" -}}
- name: ORVYN_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ default (include "orvyn.secretName" .) .Values.global.existingEncryptionSecret }}
      key: {{ if .Values.global.existingEncryptionSecret }}{{ .Values.global.encryptionSecretKey }}{{ else }}ORVYN_ENCRYPTION_KEY{{ end }}
{{- end -}}

{{- define "orvyn.storageEnv" -}}
- name: S3_ENDPOINT
  value: {{ if .Values.storage.internal.enabled }}{{ printf "http://%s-storage:8333" (include "orvyn.fullname" .) | quote }}{{ else }}{{ required "storage.external.endpoint is required" .Values.storage.external.endpoint | quote }}{{ end }}
- name: S3_BUCKET
  value: {{ .Values.storage.bucket | quote }}
- name: S3_REGION
  value: {{ .Values.storage.region | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ .Values.storage.forcePathStyle | quote }}
- name: S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      {{- if and (not .Values.storage.internal.enabled) .Values.storage.external.existingSecret }}
      name: {{ .Values.storage.external.existingSecret }}
      key: {{ .Values.storage.external.accessKeySecretKey }}
      {{- else }}
      name: {{ include "orvyn.secretName" . }}
      key: S3_ACCESS_KEY_ID
      {{- end }}
- name: S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      {{- if and (not .Values.storage.internal.enabled) .Values.storage.external.existingSecret }}
      name: {{ .Values.storage.external.existingSecret }}
      key: {{ .Values.storage.external.secretAccessKeySecretKey }}
      {{- else }}
      name: {{ include "orvyn.secretName" . }}
      key: S3_SECRET_ACCESS_KEY
      {{- end }}
{{- end -}}

{{- define "orvyn.redisEnv" -}}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      {{- if and (not .Values.valkey.enabled) .Values.externalValkey.existingSecret }}
      name: {{ .Values.externalValkey.existingSecret }}
      key: {{ .Values.externalValkey.secretKey }}
      {{- else }}
      name: {{ include "orvyn.secretName" . }}
      key: REDIS_URL
      {{- end }}
{{- end -}}

{{- define "orvyn.smtpEnv" -}}
- name: SMTP_URL
  valueFrom:
    secretKeyRef:
      name: {{ default (include "orvyn.secretName" .) .Values.smtp.existingSecret }}
      key: {{ if .Values.smtp.existingSecret }}{{ .Values.smtp.secretKey }}{{ else }}SMTP_URL{{ end }}
- name: MAIL_FROM
  value: {{ .Values.smtp.from | quote }}
{{- end -}}
