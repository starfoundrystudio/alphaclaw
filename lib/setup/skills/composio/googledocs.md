## Docs (toolkit: `googledocs`)

Common tools (verify slugs with `composio search "..." --toolkits googledocs` or `--get-schema`):

```bash
composio execute GOOGLEDOCS_GET_DOCUMENT_BY_ID -d '{"id": "..."}'
composio execute GOOGLEDOCS_CREATE_DOCUMENT -d '{"title": "...", "text": "..."}'
composio execute GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT -d '{"document_id": "...", "editDocs": [...]}'
```

- Find document IDs via the Drive toolkit when the user references a doc by name.
