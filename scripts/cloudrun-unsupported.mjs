console.error([
  "Cloud Run deployment is disabled for this release.",
  "The CRM requires persistent SQLite and WhatsApp session volumes and is deployed through the supported VPS pipeline.",
  "Use: npm run deploy:vps -- -HostName <VPS_HOST> -SshKey <SSH_KEY>",
].join("\n"));
process.exitCode = 1;
