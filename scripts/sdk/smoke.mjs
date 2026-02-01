import { SettldClient } from "../../packages/api-sdk/src/index.js";

// Minimal smoke check: ensures the SDK can be imported and instantiated.
const client = new SettldClient({ baseUrl: "http://127.0.0.1:0", tenantId: "tenant_default" });
if (!client) process.exit(1);
process.stdout.write("ok\n");

