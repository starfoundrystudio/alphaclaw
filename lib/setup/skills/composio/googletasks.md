## Tasks (toolkit: `googletasks`)

Common tools (verify slugs with `composio search "..." --toolkits googletasks` or `--get-schema`):

```bash
composio execute GOOGLETASKS_LIST_TASKS -d '{"tasklist": "@default"}'
composio execute GOOGLETASKS_INSERT_TASK -d '{"tasklist_id": "@default", "title": "..."}'
```
