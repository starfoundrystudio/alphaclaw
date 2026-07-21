## Sheets (toolkit: `googlesheets`)

Common tools (verify slugs with `composio search "..." --toolkits googlesheets` or `--get-schema`):

```bash
composio execute GOOGLESHEETS_BATCH_GET -d '{"spreadsheet_id": "...", "ranges": ["Sheet1!A1:D10"]}'
composio execute GOOGLESHEETS_BATCH_UPDATE -d '{"spreadsheet_id": "...", "sheet_name": "Sheet1", "values": [[...]]}'
composio execute GOOGLESHEETS_CREATE_GOOGLE_SHEET1 -d '{"title": "..."}'
```

- Use A1 notation for ranges; read before writing to avoid clobbering data.
