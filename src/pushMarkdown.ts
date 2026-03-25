import pfs from 'node:fs/promises';
import path from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { markdownToRichText } from '@tryfabric/martian';
import graymatter from 'gray-matter';

import { getCtx } from './actionCtx';
import { getChangedMdFiles } from './git';
import { isNotionFrontmatter } from './notion';
import { retry, RetryError } from './retry';

export async function pushUpdatedMarkdownFiles() {
  const markdownFiles = getChangedMdFiles();
  const fileFailures: { file: string; message: string }[] = [];
  for (const mdFileName of markdownFiles) {
    const res = await retry(() => pushMarkdownFile(mdFileName), {
      tries: 2,
    });

    if (res instanceof RetryError) {
      console.log('Failed to push markdown file', res);
      fileFailures.push({ file: mdFileName, message: res.message });
    }
  }
  if (fileFailures.length) {
    core.setFailed(`Files failed to push: ${JSON.stringify(fileFailures)}`);
  }
}

export async function pushMarkdownFile(mdFilePath: string) {
  const { notion, notionParentPageId } = getCtx();
  const fileContents = await pfs.readFile(mdFilePath, { encoding: 'utf-8' });
  const fileMatter = graymatter(fileContents);

  if (!isNotionFrontmatter(fileMatter.data)) {
    throw new Error(`Invalid frontmatter format for ${mdFilePath}`);
  }

  const pageData = fileMatter.data;
  let pageId: string | undefined;
  let pageTitle: string | undefined;

  if (typeof pageData.notion_page === 'string') {
    console.log('Notion page frontmatter found', {
      frontmatter: fileMatter.data,
      file: mdFilePath,
    });

    pageId = pageData.notion_page.startsWith('http')
      ? path.basename(new URL(pageData.notion_page).pathname).split('-').at(-1)
      : pageData.notion_page;

    if (!pageId) {
      throw new Error('Could not get page ID from frontmatter');
    }

    if (pageData.title) {
      pageTitle = pageData.title;
    }
  } else {
    const canonicalTitle = path.basename(mdFilePath, '.md');
    const matches = (await notion.searchPagesByTitle(canonicalTitle, notionParentPageId || undefined)).filter(
      (page) => normalizeTitle(page.title) === normalizeTitle(canonicalTitle),
    );

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
      console.log(`Created Notion page for "${canonicalTitle}": ${pageId}`);
    }

    pageTitle = canonicalTitle;
  }

  if (!pageId) {
    throw new Error(`Could not determine Notion page for ${mdFilePath}`);
  }

  console.log('Clearing page content');
  await notion.clearPage(pageId);

  if (pageTitle) {
    console.log(`Updating title: ${pageTitle}`);
    await notion.updatePageTitle(pageId, pageTitle);
  }

  console.log('Adding markdown content');
  await notion.appendMarkdown(pageId, fileMatter.content, [createWarningBlock(mdFilePath)]);
}

function normalizeTitle(value: string) {
  return value.trim().toLowerCase();
}

function createWarningBlock(fileName: string): BlockObjectRequest {
  return {
    type: 'callout',
    callout: {
      rich_text: markdownToRichText(
        `This file is linked to Github. Changes must be made in the [markdown file](${github.context.payload.repository?.html_url}/blob/${github.context.sha}/${fileName}) to be permanent.`,
      ),
      icon: {
        emoji: '⚠',
      },
      color: 'yellow_background',
    },
  };
}
