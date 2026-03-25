import * as core from '@actions/core';

import { actionStore, type SyncEngine } from './actionCtx';
import { NotionApi } from './notion';
import { pushUpdatedMarkdownFiles } from './pushMarkdown';

async function main() {
  try {
    const token = core.getInput('notion-token', { required: true });
    const notionParentPageId = core.getInput('notion-parent-page-id', { required: true });
    const syncEngineInput = core.getInput('sync-engine').trim() || 'notion-markdown';
    const syncEngine = parseSyncEngine(syncEngineInput);
    const notion = new NotionApi(token);

    await actionStore.run({ notion, notionParentPageId, syncEngine }, pushUpdatedMarkdownFiles);
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : 'Unknown reason');
  }
}

main();

function parseSyncEngine(value: string): SyncEngine {
  if (value === 'notion-markdown' || value === 'block-parser') {
    return value;
  }
  throw new Error(
    `Invalid sync-engine "${value}". Valid values are "notion-markdown" or "block-parser".`,
  );
}
