// Recently opened projects, kept in the app's user-data folder (not inside any project).
import fs from 'node:fs/promises';
import { exists, writeJsonAtomic } from './fsx.mjs';

const MAX_RECENT = 10;

export class RecentProjects {
  constructor(file) {
    this.file = file;
  }

  async list() {
    if (!(await exists(this.file))) return [];
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(data)) return [];
      return data
        .filter((x) => x && typeof x.dir === 'string' && typeof x.name === 'string')
        .slice(0, MAX_RECENT);
    } catch {
      return [];
    }
  }

  async add({ dir, name }) {
    const rest = (await this.list()).filter((x) => x.dir.toLowerCase() !== dir.toLowerCase());
    const next = [{ dir, name, openedAt: new Date().toISOString() }, ...rest].slice(0, MAX_RECENT);
    await writeJsonAtomic(this.file, next);
    return next;
  }

  async remove(dir) {
    const next = (await this.list()).filter((x) => x.dir.toLowerCase() !== dir.toLowerCase());
    await writeJsonAtomic(this.file, next);
    return next;
  }
}
