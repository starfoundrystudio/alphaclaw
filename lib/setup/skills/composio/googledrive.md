## Drive (toolkit: `googledrive`)

Common tools (verify with `composio tools list --toolkit googledrive`):

```bash
composio tools execute GOOGLEDRIVE_FIND_FILE --params-json '{"query": "name contains \"report\""}'
composio tools execute GOOGLEDRIVE_DOWNLOAD_FILE --params-json '{"file_id": "..."}'
composio tools execute GOOGLEDRIVE_UPLOAD_FILE --params-json '{"file_to_upload": "..."}'
```

- Drive search uses Drive query syntax (`name contains`, `mimeType =`, `modifiedTime >`).
- Prefer searching by name/date over listing entire folders.
