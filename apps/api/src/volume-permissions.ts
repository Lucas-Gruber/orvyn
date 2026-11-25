import { constants, type Stats } from "node:fs";
import {
  open,
  lstat,
  realpath,
  opendir,
  rename,
  unlink,
  readFile,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  createDiagnostics,
  diagnosticCode,
  RuntimeConfigurationError,
  type DiagnosticFields,
} from "@orvyn/shared/server";

type Role = "postgresql" | "valkey" | "attachments" | "storage" | "backups";
interface Options {
  mode: "probe" | "repair" | "verify";
  strategy: "auto" | "fsGroup" | "initContainer";
  recursive: "onRootMismatch" | "always" | "never";
  root: string;
  uid: number;
  gid: number;
  fsGroup?: number;
  role: Role;
  component: string;
  stateDir: string;
  stateKey: string;
  privateRoot?: string;
}
class VolumeError extends RuntimeConfigurationError {
  constructor(code: string) {
    super(
      code,
      "Volume permission preparation failed; inspect the structured filesystem diagnostic.",
    );
  }
}
function number(value: string | undefined) {
  if (
    !value ||
    !/^[0-9]+$/.test(value) ||
    Number(value) < 1 ||
    Number(value) > 4294967294
  )
    throw new VolumeError("VOLUME_CONFIGURATION_INVALID");
  return Number(value);
}
function options(args: string[]): Options {
  const [mode, ...rest] = args,
    values = new Map<string, string>();
  const names = [
    "path",
    "uid",
    "gid",
    "fs-group",
    "role",
    "component",
    "strategy",
    "recursive",
    "state-dir",
    "state-key",
    "private-root",
  ];
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, "");
    if (
      !name ||
      !rest[i]?.startsWith("--") ||
      !names.includes(name) ||
      values.has(name) ||
      rest[i + 1] === undefined
    )
      throw new VolumeError("VOLUME_CONFIGURATION_INVALID");
    values.set(name, rest[i + 1]!);
  }
  const root = values.get("path") || "",
    stateDir = values.get("state-dir") || "",
    role = values.get("role") || "",
    component = values.get("component") || role,
    strategy = values.get("strategy") || "auto",
    recursive = values.get("recursive") || "onRootMismatch",
    stateKey = values.get("state-key") || role;
  if (
    !["probe", "repair", "verify"].includes(mode) ||
    !["auto", "fsGroup", "initContainer"].includes(strategy) ||
    !["onRootMismatch", "always", "never"].includes(recursive) ||
    !["postgresql", "valkey", "attachments", "storage", "backups"].includes(
      role,
    ) ||
    !/^[a-z0-9-]{1,40}$/.test(component) ||
    !/^[a-z0-9-]{1,63}$/.test(stateKey)
  )
    throw new VolumeError("VOLUME_CONFIGURATION_INVALID");
  for (const path of [root, stateDir])
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      path === "/" ||
      path.length > 500 ||
      /[\u0000-\u001f\u007f]/u.test(path)
    )
      throw new VolumeError("VOLUME_CONFIGURATION_INVALID");
  const privateRoot = values.get("private-root");
  if (
    privateRoot &&
    (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(privateRoot) ||
      privateRoot.split("/").some((p) => p === "." || p === ".."))
  )
    throw new VolumeError("VOLUME_CONFIGURATION_INVALID");
  return {
    mode: mode as Options["mode"],
    strategy: strategy as Options["strategy"],
    recursive: recursive as Options["recursive"],
    root,
    uid: number(values.get("uid")),
    gid: number(values.get("gid")),
    ...(values.has("fs-group")
      ? { fsGroup: number(values.get("fs-group")) }
      : {}),
    role: role as Role,
    component,
    stateDir,
    stateKey,
    privateRoot,
  };
}

export async function runVolumePermissions(args: string[]) {
  const o = options(args),
    log = createDiagnostics("volume-" + o.component, process.env),
    group = o.fsGroup ?? o.gid;
  const fields: DiagnosticFields = {
    stage: "volume_permissions",
    mountPath: o.root,
    expectedUid: o.uid,
    expectedGid: o.gid,
    effectiveUid: process.getuid!(),
    effectiveGid: process.getgid!(),
    ...(o.fsGroup ? { fsGroup: o.fsGroup } : {}),
    operation: o.mode,
  };
  let changed = 0,
    visited = 0,
    skipped = 0;
  const identity = {
    version: 1,
    root: o.root,
    role: o.role,
    uid: o.uid,
    gid: o.gid,
    fsGroup: o.fsGroup ?? null,
    privateRoot: o.privateRoot ?? null,
  };
  const signature = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const markerName = ".orvyn-permissions-incomplete-" + signature;
  const statePath = join(o.stateDir, o.stateKey + ".json");
  const privatePaths =
    o.role === "attachments"
      ? ["orvyn-objects"]
      : o.role === "backups" && o.privateRoot
        ? [o.privateRoot]
        : [];
  const critical =
    o.role === "postgresql"
      ? ["pgdata"]
      : o.role === "valkey"
        ? ["appendonlydir"]
        : o.role === "attachments"
          ? ["orvyn-objects/staging"]
          : o.role === "storage"
            ? ["filerldb2"]
            : o.privateRoot
              ? [o.privateRoot]
              : [];
  function context(stat: Stats, operation: string) {
    fields.ownerUid = stat.uid;
    fields.ownerGid = stat.gid;
    fields.permissions = (stat.mode & 0o7777).toString(8).padStart(4, "0");
    fields.operation = operation;
  }
  function isPrivate(relative: string) {
    return privatePaths.some(
      (path) => relative === path || relative.startsWith(path + "/"),
    );
  }
  function privateMode(stat: Stats) {
    return stat.isDirectory() ? 0o700 : 0o600;
  }
  async function directory(path: string) {
    return open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  }
  async function root() {
    const stat = await lstat(o.root);
    context(stat, o.mode + ".root");
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(o.root)) !== o.root
    )
      throw new VolumeError("VOLUME_SYMLINK_UNSAFE");
    return directory(o.root);
  }
  const fdPath = (handle: FileHandle, name = "") =>
    "/proc/self/fd/" + handle.fd + (name ? "/" + name : "");
  async function setOwner(handle: FileHandle, stat: Stats, operation: string) {
    context(stat, operation);
    if (stat.uid !== o.uid || stat.gid !== group) {
      await handle.chown(o.uid, group);
      changed++;
    }
  }
  async function setMode(
    handle: FileHandle,
    stat: Stats,
    mode: number,
    operation: string,
  ) {
    context(stat, operation);
    if ((stat.mode & 0o7777) !== mode) {
      await handle.chmod(mode);
      changed++;
    }
  }
  // Pin parent descriptors and refuse symlinks, hardlinks and nested mounts.
  // No recursive shell command can escape through a concurrent rename.
  async function walk(
    handle: FileHandle,
    relative: string,
    device: number,
    fixOwner: boolean,
    requireOwner: boolean,
    depth = 0,
  ): Promise<void> {
    if (depth > 128) throw new VolumeError("VOLUME_NESTING_INVALID");
    let stat = await handle.stat();
    visited++;
    context(stat, o.mode + ".directory");
    if (requireOwner && stat.uid !== o.uid)
      throw new VolumeError("VOLUME_OWNER_MISMATCH");
    if (fixOwner) await setOwner(handle, stat, "repair.ownership");
    if (isPrivate(relative) && (stat.uid === o.uid || fixOwner))
      await setMode(handle, stat, 0o700, "prepare.private_directory");
    if (
      o.role === "postgresql" &&
      relative === "pgdata" &&
      (stat.mode & 0o0777) !== 0o700 &&
      (stat.mode & 0o0777) !== 0o750
    )
      await setMode(handle, stat, 0o700, "prepare.pgdata");
    const entries = await opendir(fdPath(handle));
    for await (const entry of entries) {
      if (
        !relative &&
        (entry.name === "lost+found" ||
          entry.name.startsWith(".orvyn-permissions-incomplete-"))
      )
        continue;
      const path = fdPath(handle, entry.name),
        childRelative = relative ? relative + "/" + entry.name : entry.name;
      let child: FileHandle | undefined;
      try {
        const before = await lstat(path);
        if (
          before.isSymbolicLink() ||
          before.dev !== device ||
          (!before.isDirectory() && (!before.isFile() || before.nlink !== 1))
        ) {
          skipped++;
          continue;
        }
        context(before, o.mode + ".entry");
        child = await open(
          path,
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            (before.isDirectory() ? constants.O_DIRECTORY : 0),
        );
        const current = await child.stat();
        if (
          current.dev !== device ||
          current.ino !== before.ino ||
          (current.isFile() && current.nlink !== 1)
        ) {
          skipped++;
          continue;
        }
        if (current.isDirectory())
          await walk(
            child,
            childRelative,
            device,
            fixOwner,
            requireOwner,
            depth + 1,
          );
        else if (current.isFile()) {
          visited++;
          context(current, o.mode + ".file");
          if (requireOwner && current.uid !== o.uid)
            throw new VolumeError("VOLUME_OWNER_MISMATCH");
          if (fixOwner) await setOwner(child, current, "repair.ownership");
          if (isPrivate(childRelative) && (current.uid === o.uid || fixOwner))
            await setMode(
              child,
              current,
              privateMode(current),
              "prepare.private_file",
            );
        }
      } catch (error) {
        if (!["ENOENT", "ELOOP"].includes(diagnosticCode(error))) throw error;
        skipped++;
      } finally {
        await child?.close();
      }
    }
  }
  async function marker(handle: FileHandle) {
    let file: FileHandle | undefined;
    try {
      file = await open(
        fdPath(handle, markerName),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 2048 ||
        stat.size < 2
      )
        throw new VolumeError("VOLUME_STATE_INVALID");
      let value;
      try {
        value = JSON.parse(await file.readFile("utf8"));
      } catch {
        throw new VolumeError("VOLUME_STATE_INVALID");
      }
      if (value.signature !== signature || value.version !== 1)
        throw new VolumeError("VOLUME_STATE_INVALID");
      return true;
    } catch (error) {
      if (diagnosticCode(error) === "ENOENT") return false;
      throw error;
    } finally {
      await file?.close();
    }
  }
  async function beginRepair(handle: FileHandle) {
    if (await marker(handle)) return;
    const temporary = fdPath(handle, ".orvyn-permissions-tmp-" + randomUUID());
    let file: FileHandle | undefined;
    try {
      file = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await file.chown(o.uid, group);
      await file.writeFile(JSON.stringify({ version: 1, signature }));
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, fdPath(handle, markerName));
      await handle.sync();
    } finally {
      await file?.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async function completeRepair(handle: FileHandle) {
    if (await marker(handle))
      await unlink(fdPath(handle, markerName)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
  async function writeProbe(handle: FileHandle, operation: string) {
    context(await handle.stat(), operation);
    const name = ".orvyn-probe-" + randomUUID(),
      source = fdPath(handle, name),
      target = fdPath(handle, name + ".renamed");
    let file: FileHandle | undefined;
    try {
      file = await open(
        source,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile("ok");
      await file.sync();
      await file.close();
      file = undefined;
      await rename(source, target);
      await handle.sync();
    } finally {
      await file?.close();
      for (const path of [source, target])
        await unlink(path).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }
  async function criticalDirectories(
    handle: FileHandle,
    prepare: boolean,
    fixOwner = false,
  ) {
    for (const relative of [...new Set(critical)]) {
      const parts = relative.split("/");
      let parent = handle,
        currentRelative = "";
      const opened: FileHandle[] = [];
      try {
        for (const part of parts) {
          currentRelative = currentRelative
            ? currentRelative + "/" + part
            : part;
          let child: FileHandle;
          try {
            child = await directory(fdPath(parent, part));
          } catch (error) {
            if (diagnosticCode(error) === "ENOENT") break;
            throw error;
          }
          opened.push(child);
          parent = child;
          let stat = await child.stat();
          context(stat, o.mode + ".critical");
          if (
            fixOwner &&
            o.recursive !== "never" &&
            (o.recursive === "always" ||
              stat.uid !== o.uid ||
              stat.gid !== group)
          ) {
            await walk(child, currentRelative, stat.dev, true, false);
            stat = await child.stat();
          }
          if (fixOwner) await setOwner(child, stat, "repair.critical_owner");
          else if (stat.uid !== o.uid)
            throw new VolumeError("VOLUME_OWNER_MISMATCH");
          if (isPrivate(currentRelative) && stat.mode & 0o022) {
            if (prepare || fixOwner)
              await walk(child, currentRelative, stat.dev, fixOwner, !fixOwner);
            else throw new VolumeError("VOLUME_PRIVATE_MODE_INVALID");
          }
          if (
            o.role === "postgresql" &&
            currentRelative === "pgdata" &&
            (stat.mode & 0o777) !== 0o700 &&
            (stat.mode & 0o777) !== 0o750
          ) {
            if (prepare || fixOwner)
              await setMode(child, stat, 0o700, "prepare.pgdata");
            else throw new VolumeError("VOLUME_PRIVATE_MODE_INVALID");
          }
          if (!fixOwner) await writeProbe(child, o.mode + ".critical");
        }
      } finally {
        for (const file of opened.reverse()) await file.close();
      }
    }
  }
  async function probe() {
    if (process.getuid!() !== o.uid || process.getgid!() !== o.gid)
      throw new VolumeError("VOLUME_IDENTITY_MISMATCH");
    const handle = await root();
    try {
      let stat = await handle.stat();
      context(stat, o.mode + ".root");
      if (stat.uid === o.uid && stat.mode & 0o002) {
        await setMode(
          handle,
          stat,
          stat.mode & 0o7777 & ~0o002,
          "prepare.root_mode",
        );
        stat = await handle.stat();
      }
      if (stat.mode & 0o002)
        throw new VolumeError("VOLUME_PUBLIC_MODE_INVALID");
      await writeProbe(handle, o.mode + ".root");
      if (await marker(handle)) {
        await walk(handle, "", stat.dev, false, true);
        await completeRepair(handle);
      }
      await criticalDirectories(handle, true);
    } finally {
      await handle.close();
    }
  }
  async function state(ok: boolean) {
    await writeFile(statePath, JSON.stringify({ signature, ok }), {
      mode: 0o600,
    });
  }
  try {
    if (o.mode === "probe") {
      try {
        await probe();
        await state(true);
        log.info("permissions.probe_ready", {
          ...fields,
          changedEntries: changed,
          visitedEntries: visited,
          skippedEntries: skipped,
        });
      } catch (error) {
        if (
          [
            "EACCES",
            "EPERM",
            "VOLUME_OWNER_MISMATCH",
            "VOLUME_PRIVATE_MODE_INVALID",
            "VOLUME_PUBLIC_MODE_INVALID",
          ].includes(diagnosticCode(error))
        ) {
          await state(false);
          log.warn("permissions.repair_needed", { ...fields, error });
          return;
        }
        throw error;
      }
      return;
    }
    if (o.mode === "verify") {
      await probe();
      log.info("permissions.verified", {
        ...fields,
        changedEntries: changed,
        visitedEntries: visited,
        skippedEntries: skipped,
      });
      return;
    }
    if (o.strategy === "auto") {
      const value = JSON.parse(await readFile(statePath, "utf8"));
      if (value.signature !== signature || typeof value.ok !== "boolean")
        throw new VolumeError("VOLUME_STATE_INVALID");
      if (value.ok && o.recursive !== "always") {
        log.info("permissions.repair_skipped", {
          ...fields,
          changedEntries: 0,
          visitedEntries: 0,
        });
        return;
      }
    }
    let handle: FileHandle | undefined;
    try {
      handle = await root();
      const before = await handle.stat(),
        pending = await marker(handle);
      await beginRepair(handle);
      const recurse =
        o.recursive === "always" ||
        pending ||
        (o.recursive === "onRootMismatch" &&
          (before.uid !== o.uid || before.gid !== group));
      await setOwner(handle, before, "repair.root");
      await setMode(
        handle,
        await handle.stat(),
        ((before.mode & 0o7777) | 0o700) & ~0o002,
        "repair.root_mode",
      );
      if (recurse) await walk(handle, "", before.dev, true, false);
      await criticalDirectories(handle, true, true);
      await completeRepair(handle);
      log.info("permissions.repaired", {
        ...fields,
        changedEntries: changed,
        visitedEntries: visited,
        skippedEntries: skipped,
      });
    } catch (error) {
      if (["EACCES", "EPERM"].includes(diagnosticCode(error))) {
        log.warn("permissions.repair_denied", { ...fields, error });
        return;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  } catch (error) {
    log.error("permissions.failed", {
      ...fields,
      error,
      changedEntries: changed,
      visitedEntries: visited,
      skippedEntries: skipped,
    });
    throw error;
  }
}
