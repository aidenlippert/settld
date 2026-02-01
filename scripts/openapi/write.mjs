import fs from "node:fs";
import path from "node:path";

import { buildOpenApiSpec } from "../../src/api/openapi.js";

const root = process.cwd();
const outPath = path.resolve(root, "openapi", "settld.openapi.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const spec = buildOpenApiSpec();
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
process.stdout.write(`wrote ${path.relative(root, outPath)}\n`);

