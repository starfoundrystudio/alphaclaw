## Docs (toolkit: `googledocs`)

Common tools (verify with `composio tools list --toolkit googledocs`):

```bash
composio tools execute GOOGLEDOCS_GET_DOCUMENT_BY_ID --params-json '{"id": "..."}'
composio tools execute GOOGLEDOCS_CREATE_DOCUMENT --params-json '{"title": "...", "text": "..."}'
composio tools execute GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT --params-json '{"document_id": "...", "editDocs": [...]}'
```

- Find document IDs via the Drive toolkit when the user references a doc by name.
