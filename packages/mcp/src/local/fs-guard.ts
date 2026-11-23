/**
 * Filesystem confinement for the local tools. A path is usable only if, after resolving symlinks,
 * it lies inside one of the allowed roots: the working directory (unless it is the filesystem root or
 * the home directory itself, which MCP hosts often use as a default), every `--allow-dir`, and the
 * client's MCP roots when the client offers them.
 */
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';

export class FsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsAccessError';
  }
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function realOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

export interface FsGuardOptions {
  cwd: string;
  allowDirs: string[];
  /** Extra roots from the MCP client (`roots/list`), as absolute paths. */
  clientRoots?: () => Promise<string[]>;
}

export class FsGuard {
  readonly cwd: string;
  readonly cwdExcluded: boolean;

  constructor(private readonly options: FsGuardOptions) {
    this.cwd = resolve(options.cwd);
    const isFsRoot = parse(this.cwd).root === this.cwd;
    this.cwdExcluded = isFsRoot || this.cwd === resolve(homedir());
  }

  /** Allowed roots, symlink-resolved; non-existent entries are skipped. */
  async roots(): Promise<string[]> {
    const candidates = [...(this.cwdExcluded ? [] : [this.cwd]), ...this.options.allowDirs];
    if (this.options.clientRoots) {
      try {
        candidates.push(...(await this.options.clientRoots()));
      } catch {
        // Roots are optional; ignore clients that fail to answer.
      }
    }
    const out = new Set<string>();
    for (const c of candidates) {
      const r = await realOrUndefined(resolve(this.cwd, c));
      if (r) out.add(r);
    }
    return [...out];
  }

  private describeRoots(roots: string[]): string {
    if (roots.length === 0) {
      return 'No directory is allowed: the bridge was started from the filesystem root or the home directory. Start it with --allow-dir <dir> (or LYKIA_MCP_ALLOW_DIRS).';
    }
    return `Allowed directories: ${roots.join(', ')}. Add more with --allow-dir <dir>.`;
  }

  /** Resolves an existing file for reading. */
  async resolveReadable(p: string): Promise<string> {
    if (!p || typeof p !== 'string') throw new FsAccessError('A file path is required.');
    const abs = resolve(this.cwd, p);
    const real = await realOrUndefined(abs);
    if (!real) throw new FsAccessError(`File not found: ${p}`);
    const roots = await this.roots();
    if (!roots.some((r) => isInside(r, real))) {
      throw new FsAccessError(`Access denied: ${p} is outside the allowed directories. ${this.describeRoots(roots)}`);
    }
    const st = await lstat(real);
    if (!st.isFile()) throw new FsAccessError(`Not a regular file: ${p}`);
    return real;
  }

  /**
   * Resolves a destination for writing. The final path component must not be a symlink or a directory;
   * missing parent directories are allowed (created by the caller) as long as the nearest existing
   * ancestor resolves inside an allowed root.
   */
  async resolveWritable(p: string): Promise<{ path: string; exists: boolean }> {
    if (!p || typeof p !== 'string') throw new FsAccessError('A destination path is required.');
    const abs = resolve(this.cwd, p);
    let exists = false;
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) throw new FsAccessError(`Refusing to write through a symbolic link: ${p}`);
      if (st.isDirectory()) throw new FsAccessError(`Destination is a directory: ${p}. Give a file name.`);
      exists = true;
    } catch (err) {
      if (err instanceof FsAccessError) throw err;
    }
    let ancestor = dirname(abs);
    const missing: string[] = [];
    let realAncestor = await realOrUndefined(ancestor);
    while (!realAncestor) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new FsAccessError(`Invalid destination: ${p}`);
      missing.unshift(ancestor.slice(parent.length).replace(/^[\\/]/, ''));
      ancestor = parent;
      realAncestor = await realOrUndefined(ancestor);
    }
    const target = resolve(realAncestor, ...missing, parse(abs).base);
    const roots = await this.roots();
    if (!roots.some((r) => isInside(r, target) && target !== r)) {
      throw new FsAccessError(`Access denied: ${p} is outside the allowed directories. ${this.describeRoots(roots)}`);
    }
    return { path: target, exists };
  }
}

