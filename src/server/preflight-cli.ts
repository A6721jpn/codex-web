import { getConfig } from "./config.ts";
import { runPreflightChecks } from "./preflight.ts";

const config = await getConfig(process.env);
const result = await runPreflightChecks({ codexBin: config.codexBin });
console.log(JSON.stringify(result, null, 2));

if (!result.codexVersion.ok || !result.appServerHelp.ok) {
  process.exitCode = 1;
}
