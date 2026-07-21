## Gmail (toolkit: `gmail`)

Common tools (verify slugs with `composio search "..." --toolkits gmail` or `--get-schema`):

```bash
composio execute GMAIL_FETCH_EMAILS -d '{"max_results": 10, "query": "is:unread"}'
composio execute GMAIL_SEND_EMAIL -d '{"recipient_email": "a@b.com", "subject": "Hi", "body": "..."}'
composio execute GMAIL_CREATE_EMAIL_DRAFT -d '{"recipient_email": "a@b.com", "subject": "...", "body": "..."}'
```

- Search queries use standard Gmail operators (`from:`, `is:unread`, `newer_than:7d`).
- Fetch message bodies only when needed; prefer snippet/metadata for triage.
- Confirm with the user before sending email on their behalf.
