## Drive (toolkit: `googledrive`)

Common tools (verify slugs with `composio search "..." --toolkits googledrive` or `--get-schema`):

```bash
composio execute GOOGLEDRIVE_FIND_FILE -d '{"query": "name contains \"report\""}'
composio execute GOOGLEDRIVE_DOWNLOAD_FILE -d '{"file_id": "..."}'
composio execute GOOGLEDRIVE_UPLOAD_FILE -d '{"file_to_upload": "..."}'
```

- Drive search uses Drive query syntax (`name contains`, `mimeType =`, `modifiedTime >`).
- Prefer searching by name/date over listing entire folders.
