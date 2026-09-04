import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

type FileStat = ReturnType<typeof lstatSync>;

export type ExternalModelVolumeFilesystem = Readonly<{
  lstatSync: (path: string) => FileStat;
  geteuid: () => number | undefined;
}>;

const nodeFilesystem: ExternalModelVolumeFilesystem = Object.freeze({
  lstatSync,
  geteuid: () => process.geteuid?.(),
});

/**
 * Read-only trust gate for an operator-mounted macOS model volume.  This
 * process never opens a model file: it only proves the configured mount root
 * is a protected directory and a distinct volume beneath /Volumes.
 */
export function inspectExternalModelVolumeRootSync(
  value: unknown,
  filesystem: ExternalModelVolumeFilesystem = nodeFilesystem,
): boolean {
  try {
    if (typeof value !== "string" || !/^\/Volumes\/[^/\0]+$/.test(value) || resolve(value) !== value) return false;
    const uid = filesystem.geteuid();
    if (!Number.isSafeInteger(uid) || uid! < 0) return false;
    const root = filesystem.lstatSync(value);
    const mountParent = filesystem.lstatSync(dirname(value));
    if (!safeDirectory(root, uid!) || !safeDirectory(mountParent, uid!) || root.dev === mountParent.dev) return false;
    for (let current = dirname(value); ; current = dirname(current)) {
      if (!safeDirectory(filesystem.lstatSync(current), uid!)) return false;
      if (current === "/") return true;
    }
  } catch {
    return false;
  }
}

function safeDirectory(stat: FileStat, uid: number): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (stat.uid === 0 || stat.uid === uid) && (stat.mode & 0o022) === 0;
}
