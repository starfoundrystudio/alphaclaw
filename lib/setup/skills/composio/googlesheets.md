## Sheets (toolkit: `googlesheets`)

Common tools (verify with `composio tools list --toolkit googlesheets`):

```bash
composio tools execute GOOGLESHEETS_BATCH_GET --params-json '{"spreadsheet_id": "...", "ranges": ["Sheet1!A1:D10"]}'
composio tools execute GOOGLESHEETS_BATCH_UPDATE --params-json '{"spreadsheet_id": "...", "sheet_name": "Sheet1", "values": [[...]]}'
composio tools execute GOOGLESHEETS_CREATE_GOOGLE_SHEET1 --params-json '{"title": "..."}'
```

- Use A1 notation for ranges; read before writing to avoid clobbering data.
