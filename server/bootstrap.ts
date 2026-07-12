import dotenv from "dotenv";
import path from "node:path";

const envFile = process.env.ENV_FILE || ".env";
dotenv.config({
  path: path.isAbsolute(envFile) ? envFile : path.resolve(process.cwd(), envFile),
  quiet: true,
});

// Dynamic import is intentional: configuration must exist before modules such
// as firebaseAdmin choose a database provider at module-evaluation time.
await import("../server");
