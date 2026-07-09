# Breexe Pro CRM Backup And Restore

## What The Backup Contains

`npm run backup:now` creates a zip archive with:

- SQLite data from `data/`, including an online backup of `golden-crm.db` when present.
- `.runtime/salla-integrations.json` when present.
- A `repo.bundle` containing the current Git repository history.
- `manifest.json` with branch, commit, selected non-secret env flags, and machine metadata.

By default, secrets are not included. WhatsApp Web sessions and `.env` files are included only when explicitly enabled.

## One Click Local Use

- `backup-now.cmd` creates a backup.
- `restore-last-good.cmd` restores the latest backup after the script asks you to type `RESTORE`.

Default local targets:

- `.runtime/backups`
- `Desktop/Breexe-Pro-Backups`

## Optional Cloud Targets

Set these in `.env` or `.env.production`:

```env
BACKUP_TELEGRAM_ENABLED=true
BACKUP_TELEGRAM_BOT_TOKEN=
BACKUP_TELEGRAM_CHAT_ID=

BACKUP_GOOGLE_DRIVE_ENABLED=true
BACKUP_GOOGLE_DRIVE_REMOTE=gdrive:Breexe-Pro-Backups

BACKUP_GITHUB_ENABLED=true
BACKUP_GITHUB_REPO=owner/repo
```

Google Drive requires `rclone` configured with a `gdrive` remote. GitHub release uploads require `gh auth login`. Keep `BACKUP_GITHUB_ENABLED=false` unless you are comfortable storing customer data in that repository release.

## Sensitive Options

```env
BACKUP_INCLUDE_ENV=false
BACKUP_INCLUDE_WA_SESSION=false
```

Set these to `true` only for an encrypted or private backup destination. They can contain credentials and linked WhatsApp session material.

## Restore Scope

The restore script restores data and Salla integration runtime state. It does not reset code automatically. If the manifest points to an older code commit, review `manifest.json` and check out that commit manually after confirming no local work will be lost.
