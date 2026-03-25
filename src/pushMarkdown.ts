import pfs from 'node:fs/promises';
import path from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';
import graymatter from 'gray-matter';

import { getCtx, type TargetEnv } from './actionCtx';
import { commitAndPushFiles, getChangedMdFiles, getFileContentAtRevision, type MdFileChange } from './git';
import { isNotionFrontmatter, type NotionFrontmatter } from './notion';
import { retry, RetryError } from './retry';

export async function pushUpdatedMarkdownFiles() {
  const { baseRevision, writeBackFrontmatter } = getCtx();
  const markdownFiles = getChangedMdFiles(baseRevision);
  console.log('Markdown files detected for sync', { baseRevision, markdownFiles });
  const fileFailures: { file: string; message: string }[] = [];
  const filesNeedingWriteBack: string[] = [];
  for (const mdFileChange of markdownFiles) {
    const res = await retry(() => pushMarkdownFile(mdFileChange, filesNeedingWriteBack), {
      tries: 2,
    });

    if (res instanceof RetryError) {
      console.log('Failed to push markdown file', res);
      fileFailures.push({ file: mdFileChange.path, message: res.message });
    }
  }

  if (writeBackFrontmatter && filesNeedingWriteBack.length) {
    try {
      const pushed = commitAndPushFiles(
        filesNeedingWriteBack,
        'chore: persist notion page ids in frontmatter [skip notion sync]',
      );
      console.log('Frontmatter write-back commit result', {
        files: filesNeedingWriteBack,
        pushed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown write-back failure';
      fileFailures.push({
        file: filesNeedingWriteBack.join(','),
        message: `Write-back commit failed: ${message}`,
      });
    }
  }

  if (fileFailures.length) {
    core.setFailed(`Files failed to push: ${JSON.stringify(fileFailures)}`);
  }
}

export async function pushMarkdownFile(
  mdFileChange: MdFileChange,
  filesNeedingWriteBack: string[],
) {
  const { notion, notionParentPageId, targetEnv, deletionMode, baseRevision, writeBackFrontmatter } = getCtx();
  const mdFilePath = mdFileChange.path;
  console.log('Starting markdown sync', {
    mdFileChange,
    notionParentPageId,
    targetEnv,
    deletionMode,
  });

  if (mdFileChange.status === 'D') {
    if (deletionMode === 'keep') {
      console.log('Skipping deleted markdown file because deletion-mode=keep', { file: mdFilePath });
      return;
    }
    if (!baseRevision) {
      throw new Error(`Cannot process deleted file ${mdFilePath} without base-revision input`);
    }
    const oldContent = getFileContentAtRevision(baseRevision, mdFilePath);
    if (!oldContent) {
      console.log('Deleted file content could not be loaded from base revision, skipping delete', {
        file: mdFilePath,
        baseRevision,
      });
      return;
    }
    const oldMatter = graymatter(oldContent);
    if (!isNotionFrontmatter(oldMatter.data)) {
      console.log('Deleted file has no notion frontmatter, skipping delete', { file: mdFilePath });
      return;
    }
    const pageId = resolvePageIdForEnv(oldMatter.data, targetEnv);
    if (!pageId) {
      console.log('Deleted file has no mapped Notion page id for env, skipping delete', {
        file: mdFilePath,
        targetEnv,
      });
      return;
    }
    console.log('Deleting Notion page for removed markdown file', { file: mdFilePath, pageId, targetEnv });
    await notion.deletePage(pageId);
    return;
  }

  const fileContents = await pfs.readFile(mdFilePath, { encoding: 'utf-8' });
  const fileMatter = graymatter(fileContents);

  if (!isNotionFrontmatter(fileMatter.data)) {
    throw new Error(`Invalid frontmatter format for ${mdFilePath}`);
  }

  const pageData = fileMatter.data;
  let pageId: string | undefined;
  let pageTitle: string | undefined;
  let pageCreated = false;

  const envPageId = resolvePageIdForEnv(pageData, targetEnv);
  if (typeof envPageId === 'string') {
    console.log('Notion page frontmatter found', {
      frontmatter: fileMatter.data,
      file: mdFilePath,
      targetEnv,
    });

    pageId = envPageId.startsWith('http')
      ? path.basename(new URL(envPageId).pathname).split('-').at(-1)
      : envPageId;

    if (!pageId) {
      throw new Error('Could not get page ID from frontmatter');
    }

    if (pageData.title) {
      pageTitle = pageData.title;
    }
  } else {
    const canonicalTitle = path.basename(mdFilePath, '.md');
    console.log('No notion_page frontmatter, entering upsert mode', { canonicalTitle });
    const matches = (await notion.searchPagesByTitle(canonicalTitle, notionParentPageId || undefined)).filter(
      (page) => normalizeTitle(page.title) === normalizeTitle(canonicalTitle),
    );
    console.log('Notion title matches after normalization', {
      canonicalTitle,
      matchCount: matches.length,
      matches,
    });

    if (matches.length > 1) {
      const duplicatePageInfo = matches.map((match) => `${match.title} (${match.id})`).join(', ');
      throw new Error(
        `Multiple Notion pages matched "${canonicalTitle}" for ${mdFilePath}: ${duplicatePageInfo}`,
      );
    }

    if (matches.length === 1) {
      const match = matches[0];
      pageId = match.id;
      console.log(`Found existing Notion page for "${canonicalTitle}": ${match.id}`);
    } else {
      if (!notionParentPageId) {
        throw new Error(
          `No matching Notion page for "${canonicalTitle}" and notion-parent-page-id is missing`,
        );
      }

      pageId = await notion.createPage(notionParentPageId, canonicalTitle);
      pageCreated = true;
      console.log(`Created Notion page for "${canonicalTitle}": ${pageId}`);
    }

    pageTitle = canonicalTitle;
  }

  if (!pageId) {
    throw new Error(`Could not determine Notion page for ${mdFilePath}`);
  }

  if (pageTitle) {
    console.log(`Updating title: ${pageTitle}`);
    await notion.updatePageTitle(pageId, pageTitle);
  }

  if (pageCreated) {
    setPageIdForEnv(pageData, targetEnv, pageId);
    if (writeBackFrontmatter) {
      const updatedFrontmatter = graymatter.stringify(fileMatter.content, pageData);
      await pfs.writeFile(mdFilePath, updatedFrontmatter, { encoding: 'utf-8' });
      filesNeedingWriteBack.push(mdFilePath);
      console.log('Updated frontmatter with environment page id', { file: mdFilePath, targetEnv, pageId });
    }
  }

  const sourceUrl = createGithubFileUrl(mdFilePath);

  try {
    await notion.replacePageContentWithMarkdown(
      pageId,
      createMarkdownWarningText(mdFilePath, sourceUrl, fileMatter.content),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Notion markdown validation error';
    const category = categorizeValidationIssue(message);
    throw new Error(
      [
        `Notion markdown update failed for ${mdFilePath}.`,
        `Likely issue category: ${category}.`,
        `Original error: ${message}`,
      ].join(' '),
    );
  }

  console.log('Markdown sync completed', { mdFilePath, pageId });
}

function normalizeTitle(value: string) {
  return value.trim().toLowerCase();
}

function categorizeValidationIssue(message: string) {
  const lowered = message.toLowerCase();
  if (lowered.includes('invalid url')) {
    return 'link-format';
  }
  if (lowered.includes('table row') || lowered.includes('table width')) {
    return 'table-structure';
  }
  if (lowered.includes('validation_error')) {
    return 'unsupported-markdown-construct';
  }
  return 'unknown';
}

function createMarkdownWarningText(fileName: string, sourceUrl: string | undefined, markdownContent: string) {
  const prefix = sourceUrl
    ? `> ⚠ This file is linked to Github. Changes must be made in the [markdown file](${sourceUrl}) to be permanent.`
    : `> ⚠ This file is linked to Github. Changes must be made in the markdown file (${fileName}) to be permanent.`;
  return `${prefix}\n\n${markdownContent}`;
}

function createGithubFileUrl(fileName: string) {
  const repositoryUrl = github.context.payload.repository?.html_url;
  if (!repositoryUrl || !github.context.sha) {
    return undefined;
  }
  return `${repositoryUrl}/blob/${github.context.sha}/${fileName}`;
}

function resolvePageIdForEnv(frontmatter: NotionFrontmatter, targetEnv: TargetEnv) {
  if (targetEnv === 'preview' && typeof frontmatter.notion_page_preview === 'string') {
    return frontmatter.notion_page_preview;
  }
  if (targetEnv === 'prod' && typeof frontmatter.notion_page_prod === 'string') {
    return frontmatter.notion_page_prod;
  }
  if (typeof frontmatter.notion_page === 'string') {
    return frontmatter.notion_page;
  }
  return undefined;
}

function setPageIdForEnv(frontmatter: NotionFrontmatter, targetEnv: TargetEnv, pageId: string) {
  if (targetEnv === 'preview') {
    frontmatter.notion_page_preview = pageId;
    return;
  }
  frontmatter.notion_page_prod = pageId;
}
