import { execSync } from 'node:child_process';

/**
 * A markdown file change.
 */
export interface MdFileChange {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

/**
 * Query git repo for markdown file changes between revisions.
 */
export function getChangedMdFiles(baseRevision?: string): MdFileChange[] {
  const command = baseRevision
    ? `git diff --name-status ${escapeArg(baseRevision)} HEAD`
    : 'git show --name-status --pretty=format:';
  const gitOutput = execSync(command, {
    encoding: 'utf-8',
  }).trim();

  if (!gitOutput) {
    return [];
  }

  const changes: MdFileChange[] = [];
  for (const line of gitOutput.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }

    const rawStatus = parts[0];
    const status = rawStatus[0];
    if (status === 'R' && parts.length >= 3) {
      const oldPath = parts[1];
      const path = parts[2];
      if (oldPath.endsWith('.md') || path.endsWith('.md')) {
        changes.push({ status: 'R', oldPath, path });
      }
      continue;
    }

    if ((status === 'A' || status === 'M' || status === 'D') && parts[1].endsWith('.md')) {
      changes.push({ status, path: parts[1] } as MdFileChange);
    }
  }

  return changes;
}

export function getFileContentAtRevision(revision: string, filePath: string): string | undefined {
  try {
    return execSync(`git show ${escapeArg(revision)}:${escapeArg(filePath)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
}

export function commitAndPushFiles(filePaths: string[], message: string): boolean {
  if (!filePaths.length) {
    return false;
  }

  const unique = [...new Set(filePaths)];
  execSync(`git add ${unique.map((filePath) => escapeArg(filePath)).join(' ')}`, {
    encoding: 'utf-8',
  });

  try {
    execSync('git diff --cached --quiet', { stdio: 'ignore' });
    return false;
  } catch {
    // staged changes exist
  }

  execSync('git config user.name "notion-sync-bot"', { encoding: 'utf-8' });
  execSync('git config user.email "notion-sync-bot@users.noreply.github.com"', { encoding: 'utf-8' });
  execSync(`git commit -m ${escapeArg(message)}`, { encoding: 'utf-8' });

  const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (branch) {
    execSync(`git push origin HEAD:${escapeArg(branch)}`, { encoding: 'utf-8' });
  } else {
    execSync('git push', { encoding: 'utf-8' });
  }
  return true;
}

function escapeArg(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
