import {readdir, readlink, realpath, rm, symlink} from 'node:fs/promises';
import path from 'node:path';

// fs.cp's default symlink handling can turn relative CLI links into absolute
// links to its source. Validate and rebase the final packaged copy as well.
export async function rebaseReleaseLinks(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  const canonicalDestination = await realpath(destination);
  const changes = []; let checked = 0;
  const inside = (root, file) => file === root || file.startsWith(root + path.sep);
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const original = await readlink(file), target = path.resolve(path.dirname(file), original);
        const relocated = inside(source, target) ? path.join(destination, path.relative(source, target)) : target;
        if (!inside(destination, relocated)) throw Error(`发行包链接越界：${path.relative(destination, file)}`);
        const actual = await realpath(relocated);
        if (!inside(canonicalDestination, actual)) throw Error(`发行包嵌套链接越界：${path.relative(destination, file)}`);
        const replacement = path.relative(path.dirname(file), relocated);
        if (original !== replacement) changes.push({file, original, replacement});
        checked++;
      } else if (entry.isDirectory()) await visit(file);
    }
  }
  // Finish validation before changing any link.
  await visit(destination);
  const applied = [];
  try {
    for (const entry of changes) {
      applied.push(entry);
      await rm(entry.file);
      await symlink(entry.replacement, entry.file);
    }
  } catch (error) {
    for (const entry of applied.reverse()) { await rm(entry.file, {force: true}); await symlink(entry.original, entry.file); }
    throw error;
  }
  return {checked, repaired: changes.length, allInternal: true};
}
