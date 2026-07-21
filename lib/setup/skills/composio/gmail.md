## Gmail (toolkit: `gmail`)

Common tools (verify exact names with `composio tools list --toolkit gmail`):

```bash
composio tools execute GMAIL_FETCH_EMAILS --params-json '{"max_results": 10, "query": "is:unread"}'
composio tools execute GMAIL_SEND_EMAIL --params-json '{"recipient_email": "a@b.com", "subject": "Hi", "body": "..."}'
composio tools execute GMAIL_CREATE_EMAIL_DRAFT --params-json '{"recipient_email": "a@b.com", "subject": "...", "body": "..."}'
```

- Search queries use standard Gmail operators (`from:`, `is:unread`, `newer_than:7d`).
- Fetch message bodies only when needed; prefer snippet/metadata for triage.
- Confirm with the user before sending email on their behalf.
