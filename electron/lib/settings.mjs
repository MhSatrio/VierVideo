// App settings (kept in the user-data folder, never inside a project).
import fs from 'node:fs/promises';
import { exists, writeJsonAtomic } from './fsx.mjs';

export class Settings {
  constructor(file) {
    this.file = file;
  }

  async read() {
    if (!(await exists(this.file))) return {};
    try {
      const v = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  async update(patch) {
    const next = { ...(await this.read()), ...patch };
    await writeJsonAtomic(this.file, next);
    return next;
  }
}
