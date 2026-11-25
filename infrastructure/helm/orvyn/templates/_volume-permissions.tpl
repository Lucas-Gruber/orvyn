{{- define "orvyn.permissionUid" -}}
{{- coalesce .settings.securityContext.runAsUser .settings.podSecurityContext.runAsUser (ternary 999 1000 (has .role (list "postgresql" "valkey" "backups"))) | int64 -}}
{{- end }}
{{- define "orvyn.permissionGid" -}}
{{- coalesce .settings.securityContext.runAsGroup .settings.podSecurityContext.runAsGroup (ternary 999 1000 (has .role (list "postgresql" "valkey" "backups"))) | int64 -}}
{{- end }}
{{- define "orvyn.permissionVolumeGid" -}}
{{- default (include "orvyn.permissionGid" .) .settings.podSecurityContext.fsGroup | int64 -}}
{{- end }}
{{- define "orvyn.permissionInit" -}}
{{- $root := .root }}{{- $permission := $root.Values.volumePermissions }}
{{- $uid := include "orvyn.permissionUid" . | int64 }}{{- $gid := include "orvyn.permissionGid" . | int64 }}
{{- $image := ternary $permission.image $root.Values.api.image (ne $permission.image.repository "") }}
{{- $phases := list "verify" }}
{{- if eq $permission.strategy "auto" }}{{- $phases = list "probe" "repair" "verify" }}{{- else if eq $permission.strategy "initContainer" }}{{- $phases = list "repair" "verify" }}{{- end }}
{{- $args := list "--path" (clean .path) "--uid" (toString $uid) "--gid" (toString $gid) "--role" .role "--component" .component "--strategy" $permission.strategy "--recursive" $permission.recursive "--state-dir" "/run/orvyn-permissions" "--state-key" .volume }}
{{- if .settings.podSecurityContext.fsGroup }}{{- $args = concat $args (list "--fs-group" (toString .settings.podSecurityContext.fsGroup)) }}{{- end }}
{{- if .privateRoot }}{{- $args = concat $args (list "--private-root" .privateRoot) }}{{- end }}
{{- $context := . }}
{{- range $phase := $phases }}
{{- $security := deepCopy (ternary $permission.securityContext $permission.probeSecurityContext (eq $phase "repair")) }}
{{- if ne $phase "repair" }}
{{- $_ := set $security "runAsUser" $uid }}{{- $_ := set $security "runAsGroup" $gid }}{{- $_ := set $security "runAsNonRoot" true }}
{{- end }}
- name: volume-{{ $context.volume }}-{{ $phase }}
  image: {{ include "orvyn.image" (dict "root" $root "image" $image) | quote }}
  imagePullPolicy: {{ $image.pullPolicy }}
  command: [node, dist/commands/volume-permissions.js]
  args: {{ toJson (concat (list $phase) $args) }}
  securityContext: {{- toYaml $security | nindent 4 }}
  resources: {{- toYaml $permission.resources | nindent 4 }}
  env:
    - name: ORVYN_LOG_LEVEL
      value: {{ $root.Values.logging.level | quote }}
  volumeMounts:
    - name: {{ $context.volume }}
      mountPath: {{ $context.path | quote }}
    - name: volume-permissions-state
      mountPath: /run/orvyn-permissions
{{- end }}
{{- end }}
{{- define "orvyn.permissionState" -}}
- name: volume-permissions-state
  emptyDir:
    sizeLimit: 16Mi
{{- end }}
