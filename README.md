---
notion_page: https://joshstern.notion.site/Github-Markdown-files-in-Notion-e2c1415d3253487baeb54fbe5d7383d0
title: Github Markdown files in Notion
---

# Managing markdown documentation

As projects scale it's important to keep documentation accessible and up-to-date. README's and other markdown files that live alongside source can be extremely useful for building context as you work throughout a repository.

For many organizations Notion is the central store for documentation. This project lets engineers continue to author documentation alongside their work and also make sure it stays up to date with the broader organization documentation.

# Usage

This Github action automatically scans commits for markdown changes and uses some frontmatter fields to push the changes to Notion.

It's intentionally set up to be used with an internal integration so document data stays within your organization.

## 1. Get an integration key

Head to the [Notion dashboard](https://www.notion.so/my-integrations) and create a new internal integration. It will need read, update, and insert capabilities.

## 2. Configure a Github workflow

This workflow will run for every push to `main`. It is dependent on having access to `git` and the repo being checked. It will check the latest commit on whichever branch is checked out for markdown changes. Make sure to add `fetch-depth: 2` for the diff check to work correctly.

```yaml
on:
  push:
    branches:
      - main
jobs:
  push_markdown_job:
    runs-on: ubuntu-latest
    name: Push Markdown to Notion
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - name: Push Markdown to Notion
        uses: JoshStern/push-md-to-notion@v0.4.0
        id: push_markdown
        with:
          notion-token: ${{ secrets.NOTION_TOKEN }}
          notion-parent-page-id: ${{ secrets.NOTION_PARENT_PAGE_ID }}
          target-env: preview
          deletion-mode: hard-delete
          resolution-mode: name-based
          write-back-frontmatter: false
          base-revision: ${{ github.event.pull_request.base.sha }}
```

## 3. Choose a Notion parent page and add the integration

Share a Notion page with your integration and use its page ID as `notion-parent-page-id`. New markdown files are created as child pages under this parent when no `notion_page` frontmatter is provided.

## 4. Add optional frontmatter overrides

You can still pin a markdown file to a specific Notion page:

```
---
notion_page: https://www.notion.so/<your_path>
title: <Your Title>
---

# My README

This content will by synced to Notion!
```

If `notion_page` is omitted, the action tries to find a Notion page by matching filename (without `.md`) to page title using trimmed, case-insensitive comparison:
- one match: update that page
- no match: create a new page under `notion-parent-page-id`
- multiple matches: fail for that file as ambiguous

## Optional behavior inputs

- `target-env`: `preview` or `prod` (default: `preview`)
- `deletion-mode`: `hard-delete` or `keep` (default: `hard-delete`)
- `resolution-mode`: `name-based` or `id-based` (default: `name-based`)
- `write-back-frontmatter`: `true` or `false` (default: `false`)
- `base-revision`: git SHA to diff against for add/modify/rename/delete detection

# Current Features

- Syncs markdown changes by git status (add/modify/rename/delete) between `base-revision` and `HEAD`.
- Supports optional update-by-ID with frontmatter `notion_page`, plus env-specific mapping:
  - `notion_page_preview`
  - `notion_page_prod`
- Supports name-based resolution by filename/title under the configured parent page.
- Supports create-or-update (upsert) when `notion_page` is absent:
  - page title = markdown filename without `.md`
  - trimmed, case-insensitive title match
  - create page under `notion-parent-page-id` when no match exists
- Uses Notion native markdown API for page content updates.
- Preserves backward compatibility for existing files that already use `notion_page`.
- Replaces existing page content with markdown using Notion's own parser.
- Adds a markdown warning blockquote at the top pointing to the GitHub source file.
- Handles deleted markdown files with `deletion-mode: hard-delete` by moving mapped Notion pages to trash.
- Optionally writes created page IDs back to frontmatter and pushes a bot commit.

# Current Limitations

- Rendering behavior follows Notion markdown API rules (some markdown/HTML variants may still render differently than GitHub).
- Local/relative image paths are not uploaded by this action; use publicly reachable image URLs.
- Duplicate page-title matches under the selected parent are treated as errors.
- Requires `notion-parent-page-id` input for create-path behavior.

# Limitations

## Notion API

This tool has all of the standard [Notion API limits](https://developers.notion.com/reference/request-limits).

# Thanks

This project is mostly a wire-up of the [Notion client](https://www.npmjs.com/package/@notionhq/client). Many thanks to the maintainers.
