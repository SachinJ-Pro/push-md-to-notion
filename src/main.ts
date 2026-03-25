import * as core from '@actions/core';

import { actionStore, type DeletionMode, type ResolutionMode, type TargetEnv } from './actionCtx';
import { NotionApi } from './notion';
import { pushUpdatedMarkdownFiles } from './pushMarkdown';

async function main() {
  try {
    const token = core.getInput('notion-token', { required: true });
    const notionParentPageId = core.getInput('notion-parent-page-id', { required: true });
    const targetEnv = parseTargetEnv(core.getInput('target-env').trim() || 'preview');
    const deletionMode = parseDeletionMode(core.getInput('deletion-mode').trim() || 'hard-delete');
    const resolutionMode = parseResolutionMode(core.getInput('resolution-mode').trim() || 'name-based');
    const writeBackFrontmatter = parseBooleanInput(core.getInput('write-back-frontmatter').trim() || 'false');
    const baseRevision = core.getInput('base-revision').trim() || undefined;
    const notion = new NotionApi(token);

    await actionStore.run(
      {
        notion,
        notionParentPageId,
        targetEnv,
        deletionMode,
        resolutionMode,
        writeBackFrontmatter,
        baseRevision,
      },
      pushUpdatedMarkdownFiles,
    );
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : 'Unknown reason');
  }
}

main();

function parseTargetEnv(value: string): TargetEnv {
  if (value === 'preview' || value === 'prod') {
    return value;
  }
  throw new Error(`Invalid target-env "${value}". Valid values are "preview" or "prod".`);
}

function parseDeletionMode(value: string): DeletionMode {
  if (value === 'hard-delete' || value === 'keep') {
    return value;
  }
  throw new Error(`Invalid deletion-mode "${value}". Valid values are "hard-delete" or "keep".`);
}

function parseResolutionMode(value: string): ResolutionMode {
  if (value === 'name-based' || value === 'id-based') {
    return value;
  }
  throw new Error(`Invalid resolution-mode "${value}". Valid values are "name-based" or "id-based".`);
}

function parseBooleanInput(value: string) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Invalid boolean input "${value}". Valid values are "true" or "false".`);
}
