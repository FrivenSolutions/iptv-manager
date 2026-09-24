// Which commit is running. Git checkouts (Proxmox installs, development) are read directly;
// Docker images carry a version.json written at build time, since the image has no .git.
//   node src/version.js --write <file>   (used by the Dockerfile)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;

/** Resolve HEAD of a git checkout without the git binary: detached, loose ref or packed ref. */
export function readGitCommit(dir) {
  const git = path.join(dir, '.git');
  try {
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, '');
    try {
      const loose = fs.readFileSync(path.join(git, ref), 'utf8').trim();
      if (SHA.test(loose)) return loose;
    } catch {}
    const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line && SHA.test(line.slice(0, 40)) ? line.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/** { commit, source } for the app rooted at `root`; commit is null when unknown. */
export function currentVersion(root) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
    if (v && SHA.test(v.commit || '')) return { commit: v.commit, source: 'build' };
  } catch {}
  const commit = readGitCommit(root);
  return { commit, source: commit ? 'git' : 'unknown' };
}

// CLI: record the commit of the checkout this file lives in (Docker build stage).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--write') {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const commit = readGitCommit(root);
  fs.writeFileSync(process.argv[3], JSON.stringify({ commit }) + '\n');
  console.log(`version.json: ${commit || 'commit unknown (no .git in the build context)'}`);
}
