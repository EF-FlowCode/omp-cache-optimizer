import fsp from "node:fs/promises";
import type { Stats } from "node:fs";

/**
 * The read-only filesystem calls a footer refresh makes (shard index,
 * archive reader, epoch reads), behind one replaceable facade so tests can
 * count or fault them without monkeypatching node:fs/promises (fragile
 * under jiti's ESM named bindings). Production never replaces it; every
 * call looks up the fs/promises function at call time.
 */
export type StatsReadFs = {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
  readFile(path: string): Promise<Buffer>;
};

const realStatsReadFs: StatsReadFs = {
  readdir: (path) => fsp.readdir(path),
  lstat: (path) => fsp.lstat(path),
  stat: (path) => fsp.stat(path),
  readFile: (path) => fsp.readFile(path),
};

let current: StatsReadFs = realStatsReadFs;

/** The facade in effect (real fs unless a test replaced it). */
export function statsReadFs(): StatsReadFs {
  return current;
}

/** Test hook: replace the facade (undefined restores the real filesystem). */
export function setStatsReadFsForTests(fs: StatsReadFs | undefined): void {
  current = fs ?? realStatsReadFs;
}

export type StatsReadFsCounts = { readdir: number; lstat: number; stat: number; readFile: number; paths: string[] };

/** Test helper: a facade over `base` that counts calls (and records paths). */
export function countingStatsReadFs(base: StatsReadFs = realStatsReadFs): { fs: StatsReadFs; counts: StatsReadFsCounts; reset(): void } {
  const counts: StatsReadFsCounts = { readdir: 0, lstat: 0, stat: 0, readFile: 0, paths: [] };
  const wrap = <K extends keyof StatsReadFs>(name: K): StatsReadFs[K] => (async (path: string) => {
    counts[name]++;
    counts.paths.push(`${name} ${path}`);
    return (base[name] as (path: string) => Promise<unknown>)(path);
  }) as StatsReadFs[K];
  return {
    fs: { readdir: wrap("readdir"), lstat: wrap("lstat"), stat: wrap("stat"), readFile: wrap("readFile") },
    counts,
    reset() {
      counts.readdir = 0; counts.lstat = 0; counts.stat = 0; counts.readFile = 0; counts.paths.length = 0;
    },
  };
}
