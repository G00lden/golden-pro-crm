import { spawnSync } from "node:child_process";

const files = [
  "scripts/version-policy.test.mjs",
  "scripts/server-mode.test.mjs",
  "scripts/schema-migration.test.mjs",
  "scripts/user-identity.test.mjs",
  "scripts/vps-backup-restore.test.mjs",
  "shared/date.test.ts",
  "shared/financial.test.ts",
  "shared/phone.test.ts",
  "shared/zatca.test.ts",
  "server/localAuthPolicy.test.ts",
  "server/salla.test.ts",
  "server/sallaBidirectional.test.ts",
  "server/sallaOrderControl.test.ts",
  "server/sallaOrderCommandJournal.test.ts",
  "server/sallaOrderInbox.test.ts",
  "server/crmValidation.test.ts",
  "server/communicationStatus.test.ts",
  "server/communicationJobs.test.ts",
  "server/communicationEvents.test.ts",
  "server/communicationPreferences.test.ts",
  "server/communicationCampaigns.test.ts",
  "server/whatsappTemplates.test.ts",
  "server/whatsappConnection.test.ts",
  "server/telephony/unifonicAdapter.test.ts",
  "server/userValidation.test.ts",
  "server/repositories/ownedRepository.test.ts",
  "server/crmApi.customerPagination.test.ts",
  "server/storeOrderPagination.test.ts",
  "server/storeOrderQuery.test.ts",
  "server/storeOrderRealtime.test.ts",
  "server/supabaseFirestoreAdapter.test.ts",
  "src/dataProvider.test.ts",
  "src/pages/Settings.store-link.test.ts",
];

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
