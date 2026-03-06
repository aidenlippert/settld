#!/usr/bin/env node
import { runCli } from '../src/agentverse/cli/commands.js';

const code = await runCli(process.argv.slice(2));
process.exit(code);
